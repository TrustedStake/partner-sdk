// @vitest-environment node
import { beforeAll, describe, it, expect, vi } from "vitest";
import {
  blake2AsHex,
  createKeyMulti,
  cryptoWaitReady,
  encodeAddress,
  sortAddresses,
} from "@polkadot/util-crypto";
import {
  prepareMultisigAction,
  createAuthorizationDeposit,
  verifyAuthorizationDeposit,
  prepareAuthorizationCancellation,
  submitPreparedMultisigAction,
  createAuthorizationTransport,
} from "../src/polkadot/actions";
import type { PendingMultisigOp } from "../src/polkadot/types";
import { createServerBridge } from "../src/server";
const hash = (c: string) => "0x" + c.repeat(64),
  signers = [1, 2, 3].map((n) => encodeAddress(new Uint8Array(32).fill(n), 42));
const id = "550e8400-e29b-41d4-a716-446655440000";
beforeAll(() => cryptoWaitReady());
function fixture() {
  const managed = encodeAddress(createKeyMulti(signers, 2), 42),
    now = new Date().toISOString();
  const op: PendingMultisigOp = {
    id: "test",
    chainId: hash("a"),
    threshold: 2,
    signatories: signers,
    sortedSignatories: sortAddresses(signers, 42),
    multisigAddress: managed,
    managedAccount: managed,
    currentSigner: signers[0],
    callDataHex: "0x01020304",
    callHashHex: blake2AsHex("0x01020304"),
    timepoint: { height: 3, index: 1 },
    runtime: { specVersion: 1, transactionVersion: 1 },
    operationKind: "other",
    operationLabel: "test",
    status: "pending_approvals",
    createdAt: now,
    updatedAt: now,
  };
  let approvals = [signers[0]],
    pending = true;
  const tx = {};
  const builders = {
    asMulti: vi.fn(() => tx),
    approveAsMulti: vi.fn(() => tx),
    cancelAsMulti: vi.fn(() => tx),
  };
  const value = (n: number) => ({ toNumber: () => n });
  const runtime = { specVersion: value(1), transactionVersion: value(1) };
  const api: any = {
    genesisHash: { toHex: () => hash("a") },
    runtimeVersion: runtime,
    registry: { createType: vi.fn((_name: string, v: unknown) => v) },
    tx: Object.assign(
      vi.fn(() => ({
        paymentInfo: async () => ({
          weight: { toJSON: () => ({ refTime: 1000, proofSize: 20 }) },
        }),
      })),
      { multisig: builders },
    ),
    rpc: {
      chain: {
        getFinalizedHead: async () => hash("f"),
        getHeader: async () => ({ number: value(20) }),
        getBlockHash: async () => hash("b"),
      },
      state: { getRuntimeVersion: async () => runtime },
    },
    at: async () => ({
      query: {
        multisig: {
          multisigs: async () =>
            pending
              ? {
                  isNone: false,
                  unwrap: () => ({
                    when: { height: value(3), index: value(1) },
                    approvals: { toJSON: () => approvals },
                    depositor: { toString: () => signers[0] },
                  }),
                }
              : { isNone: true },
        },
      },
    }),
  };
  const request = vi.fn(async (action: string) => ({
    success: true,
    data:
      action === "verify"
        ? {
            managedWalletAddress: managed,
            signerAddress: signers[0],
            chainId: "finney",
            verifiedAt: now,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          }
        : {
            // Matches current API: challenge has a template; only resolve adds genesisHash.
            ...(action === "resolve"
              ? { genesisHash: hash("a") }
              : {
                  approveAsMultiTemplate: {
                    pallet: "multisig",
                    method: "approveAsMulti",
                    callHash: op.callHashHex,
                  },
                }),
            challengeId: id,
            challengeCallHash: op.callHashHex,
            managedWalletAddress: managed,
            signerAddress: signers[0],
            chainId: "finney",
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
  }));
  const auth = {
    ...op,
    callDataHex: "0x",
    authorizationProof: {
      challengeId: id,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
    depositor: signers[0],
  };
  return {
    op,
    auth,
    api,
    builders,
    request,
    set pending(v: boolean) {
      pending = v;
    },
    set approvals(v: string[]) {
      approvals = v;
    },
  };
}
describe("headless multisig actions", () => {
  it("builds threshold-completing execution with original timepoint and detects later approval changes", async () => {
    const f = fixture();
    const prepared = await prepareMultisigAction(
      f.api,
      f.op,
      signers[1],
      "approve",
      () => {},
    );
    expect(f.builders.asMulti).toHaveBeenCalledTimes(1);
    expect(f.builders.asMulti.mock.calls[0]).toEqual(
      expect.arrayContaining([f.op.timepoint]),
    );
    f.approvals = [signers[0], signers[2]];
    await expect(prepared.assertCurrent()).rejects.toThrow("changed");
  });
  it("refuses double approval and never executes authorization hashes", async () => {
    const f = fixture();
    await expect(
      prepareMultisigAction(f.api, f.op, signers[0], "approve", () => {}),
    ).rejects.toThrow("already approved");
    await expect(
      prepareMultisigAction(f.api, f.auth, signers[1], "approve", () => {}),
    ).rejects.toThrow("cannot be executed");
    expect(f.builders.asMulti).not.toHaveBeenCalled();
  });
  it("never resubmits a vanished uncertain proposal", async () => {
    const f = fixture();
    f.pending = false;
    await expect(
      prepareMultisigAction(
        f.api,
        { ...f.op, timepoint: null, status: "needs_review" },
        signers[1],
        "approve",
        () => {},
      ),
    ).rejects.toThrow("Uncertain");
  });
  it("allows cancellation only by the depositor, including after runtime upgrade", async () => {
    const f = fixture();
    f.api.runtimeVersion = {
      specVersion: { toNumber: () => 2 },
      transactionVersion: { toNumber: () => 1 },
    };
    await expect(
      prepareMultisigAction(f.api, f.op, signers[1], "cancel", () => {}),
    ).rejects.toThrow("depositor");
    await prepareMultisigAction(f.api, f.op, signers[0], "cancel", () => {});
    expect(f.builders.cancelAsMulti).toHaveBeenCalledTimes(1);
    await expect(
      prepareMultisigAction(f.api, f.op, signers[1], "approve", () => {}),
    ).rejects.toThrow("runtime");
  });
  it("journals before submission, blocks duplicates, and preserves uncertainty on a lost result", async () => {
    const f = fixture();
    const prepared = await prepareMultisigAction(
      f.api,
      f.op,
      signers[1],
      "approve",
      () => {},
    );
    const save = vi.fn(),
      submit = vi.fn(async () => {
        expect(save).toHaveBeenCalledWith(
          expect.objectContaining({ status: "needs_review" }),
        );
        throw new Error("lost");
      });
    await expect(
      submitPreparedMultisigAction(prepared, submit, save),
    ).rejects.toThrow("lost");
    await expect(
      submitPreparedMultisigAction(prepared, submit, save),
    ).rejects.toThrow("already submitted");
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("storage failure prevents submission", async () => {
    const f = fixture();
    const prepared = await prepareMultisigAction(
      f.api,
      f.op,
      signers[1],
      "approve",
      () => {},
    );
    const submit = vi.fn();
    await expect(
      submitPreparedMultisigAction(prepared, submit, () => {
        throw new Error("storage");
      }),
    ).rejects.toThrow("storage");
    expect(submit).not.toHaveBeenCalled();
  });
  it("records a finalized receipt without asserting execution success", async () => {
    const f = fixture();
    const prepared = await prepareMultisigAction(
      f.api,
      f.op,
      signers[1],
      "approve",
      () => {},
    );
    const save = vi.fn();
    const result = await submitPreparedMultisigAction(
      prepared,
      async () => ({ blockHash: hash("b"), transactionHash: hash("c") }),
      save,
    );
    expect(result.status).toBe("needs_review");
    expect(result.extrinsicHash).toBe(hash("c"));
    expect(save).toHaveBeenCalledTimes(2);
  });
  it("creates only server-issued hash approval, then resumes verification without another deposit", async () => {
    const f = fixture();
    f.pending = false;
    const prepared = await createAuthorizationDeposit(
      f.api,
      signers,
      2,
      signers[0],
      f.request,
      () => {},
    );
    expect(prepared.operation.callDataHex).toBe("0x");
    expect(f.builders.approveAsMulti).toHaveBeenCalledTimes(1);
    expect(f.builders.asMulti).not.toHaveBeenCalled();
    f.pending = true;
    await expect(prepared.assertCurrent()).rejects.toThrow("already exists");
    const saved = vi.fn();
    const result = await verifyAuthorizationDeposit(
      f.api,
      prepared.operation,
      signers[0],
      f.request,
      () => {},
      saved,
    );
    expect(result.operation.timepoint).toEqual({ height: 3, index: 1 });
    expect(saved).toHaveBeenCalled();
    expect(f.builders.approveAsMulti).toHaveBeenCalledTimes(1);
  });
  it("rejects server network substitution before preparing any deposit", async () => {
    const f = fixture();
    f.pending = false;
    const request = async () => ({
      success: true,
      data: { ...(await f.request("challenge")).data, genesisHash: hash("b") },
    });
    await expect(
      createAuthorizationDeposit(
        f.api,
        signers,
        2,
        signers[0],
        request,
        () => {},
      ),
    ).rejects.toThrow("network");
    expect(f.builders.approveAsMulti).not.toHaveBeenCalled();
  });
  it("requires resolved original authorization proof and depositor for cancellation", async () => {
    const f = fixture();
    await expect(
      prepareAuthorizationCancellation(
        f.api,
        f.auth,
        signers[1],
        f.request,
        () => {},
      ),
    ).rejects.toThrow("original");
    const prepared = await prepareAuthorizationCancellation(
      f.api,
      f.auth,
      signers[0],
      f.request,
      () => {},
    );
    expect(f.builders.cancelAsMulti).toHaveBeenCalledTimes(1);
    f.pending = false;
    await expect(prepared.assertCurrent()).rejects.toThrow("disappeared");
  });
  it("stops authorization when the host wallet guard changes", async () => {
    const f = fixture();
    f.pending = false;
    let current = true;
    const request = async (action: any, body: any) => {
      const r = await f.request(action);
      current = false;
      return r;
    };
    await expect(
      createAuthorizationDeposit(f.api, signers, 2, signers[0], request, () => {
        if (!current) throw new Error("wallet changed");
      }),
    ).rejects.toThrow("wallet changed");
    expect(f.builders.approveAsMulti).not.toHaveBeenCalled();
  });
});
describe("native multisig bridge", () => {
  it("forwards only bounded authorized endpoints without the private partner credential", async () => {
    const upstream = vi.fn(async (_url: any, _init: any) =>
        Response.json({ success: true, data: {} }),
      ),
      credential = vi.fn(async () => "tsp_" + "x".repeat(32));
    const bridge = createServerBridge({
      fetch: upstream,
      apiOrigin: "https://api.example",
      partnerPrefix: "/bridge",
      allocationPrefix: "/rebalance",
      multisigPrefix: "/multisig",
      partnerCredential: credential,
      authorize: async () => true,
    });
    const transport = createAuthorizationTransport(
      (async (url: any, init: any) =>
        bridge(
          new Request("https://partner.example" + url, init),
        )) as typeof fetch,
      "/multisig",
    );
    await transport("resolve", {
      managedWalletAddress: signers[0],
      signerAddress: signers[1],
      chainId: "finney",
      challengeId: id,
    });
    expect(upstream.mock.calls[0][0]).toBe(
      "https://api.example/api/v1/multisig/auth/resolve",
    );
    expect(upstream.mock.calls[0][1].headers.has("authorization")).toBe(false);
    expect(credential).not.toHaveBeenCalled();
    const bad = await bridge(
      new Request("https://partner.example/multisig/revoke", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(bad.status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("rejects overlapping bridge prefixes and external authorization origins", () => {
    expect(() =>
      createServerBridge({
        fetch,
        apiOrigin: "https://api.example",
        partnerPrefix: "/bridge",
        allocationPrefix: "/bridge/allocation",
        authorize: async () => true,
        partnerCredential: async () => "",
      }),
    ).toThrow("overlap");
    expect(() =>
      createAuthorizationTransport(fetch, "https://evil.example"),
    ).toThrow("same-origin");
  });
});
