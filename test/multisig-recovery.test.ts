// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  blake2AsHex,
  createKeyMulti,
  cryptoWaitReady,
  encodeAddress,
} from "@polkadot/util-crypto";
import type { ApiPromise } from "@polkadot/api";
import type { PendingMultisigOp } from "../src/polkadot/types";
import {
  assertProposalRuntime,
  exportMultisigProposal,
  importMultisigProposal,
  verifyMultisigReceipt,
} from "../src/polkadot/multisig-recovery";
import {
  getMultisigOutcomeMessage,
  inferPendingOpStatus,
  isMultisigExecuted,
} from "../src/polkadot/multisig";

const hash = (n: string) => `0x${n.repeat(64)}`;
const number = (n: number) => ({
  toNumber: () => n,
  toBigInt: () => BigInt(n),
  toString: () => String(n),
});
const signatories = [1, 2, 3].map((n) =>
  encodeAddress(new Uint8Array(32).fill(n), 42),
);
let op: PendingMultisigOp;
beforeAll(async () => {
  await cryptoWaitReady();
  const multisigAddress = encodeAddress(createKeyMulti(signatories, 2), 42);
  op = {
    id: "proposal",
    chainId: hash("a"),
    multisigAddress,
    managedAccount: multisigAddress,
    threshold: 2,
    signatories,
    sortedSignatories: signatories,
    callDataHex: "0x01020304",
    callHashHex: blake2AsHex("0x01020304"),
    timepoint: { height: 10, index: 0 },
    runtime: { specVersion: 479, transactionVersion: 1 },
    operationKind: "other",
    operationLabel: "Transaction",
    status: "ready_to_execute",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
});
function fixture() {
  const events: any[] = [
    {
      phase: { isApplyExtrinsic: true, asApplyExtrinsic: number(0) },
      event: { section: "system", method: "ExtrinsicSuccess", data: [] },
    },
  ];
  const storage = vi.fn().mockResolvedValue({ isNone: true });
  const runtime = { specVersion: number(479), transactionVersion: number(1) };
  const api = {
    genesisHash: { toHex: () => hash("a") },
    runtimeVersion: runtime,
    at: vi
      .fn()
      .mockResolvedValue({ query: { multisig: { multisigs: storage } } }),
    rpc: {
      chain: {
        getFinalizedHead: vi.fn().mockResolvedValue(hash("f")),
        getHeader: vi.fn().mockResolvedValue({ number: number(20) }),
        getBlockHash: vi.fn().mockResolvedValue({ toHex: () => hash("b") }),
        getBlock: vi.fn().mockResolvedValue({
          block: { extrinsics: [{ hash: { toHex: () => hash("c") } }] },
        }),
      },
      state: { getRuntimeVersion: vi.fn().mockResolvedValue(runtime) },
    },
    query: { system: { events: { at: vi.fn().mockResolvedValue(events) } } },
  };
  const event = (
    method = "MultisigExecuted",
    result = { isOk: true, isErr: false },
  ) => ({
    phase: { isApplyExtrinsic: true, asApplyExtrinsic: number(0) },
    event: {
      section: "multisig",
      method,
      data: [
        signatories[1],
        { toJSON: () => op.timepoint },
        op.multisigAddress,
        op.callHashHex,
        {
          ...result,
          toJSON: () => (result.isOk ? { ok: null } : { err: "failure" }),
        },
      ],
    },
  });
  return {
    api: api as unknown as ApiPromise,
    raw: api,
    events,
    storage,
    event,
    receipt: () => ({ ...op, blockHash: hash("b"), extrinsicHash: hash("c") }),
  };
}
describe("portable multisig recovery", () => {
  it("imports on a second device without trusting a claimed outcome", async () => {
    const f = fixture();
    const imported = await importMultisigProposal(
      f.api,
      exportMultisigProposal(op),
      signatories[1],
    );
    expect(imported.status).toBe("needs_review");
    expect(imported.callHashHex).toBe(op.callHashHex);
    expect(imported.multisigAddress).toBe(op.multisigAddress);
    expect(exportMultisigProposal(op)).not.toContain("signature");
  });
  it.each([
    [
      "unknown field",
      (v: any) => {
        v.status = "executed";
      },
    ],
    [
      "wrong account",
      (v: any) => {
        v.multisigAddress = signatories[0];
      },
    ],
    [
      "duplicate signer",
      (v: any) => {
        v.signatories[1] = v.signatories[0];
      },
    ],
    [
      "network",
      (v: any) => {
        v.genesisHash = hash("d");
      },
    ],
    [
      "call hash",
      (v: any) => {
        v.callDataHex = "0x05060708";
      },
    ],
    [
      "forged runtime",
      (v: any) => {
        v.runtime.specVersion = 480;
      },
    ],
    [
      "future proposal",
      (v: any) => {
        v.timepoint.height = 30;
      },
    ],
    [
      "bad threshold",
      (v: any) => {
        v.threshold = 4;
      },
    ],
    [
      "bad timepoint",
      (v: any) => {
        v.timepoint.index = -1;
      },
    ],
  ])("rejects %s before signing", async (_, mutate) => {
    const f = fixture(),
      value = JSON.parse(exportMultisigProposal(op));
    mutate(value);
    await expect(
      importMultisigProposal(f.api, JSON.stringify(value), signatories[1]),
    ).rejects.toThrow();
  });
  it("rejects an unrelated signer", async () => {
    await expect(
      importMultisigProposal(
        fixture().api,
        exportMultisigProposal(op),
        encodeAddress(new Uint8Array(32).fill(9)),
      ),
    ).rejects.toThrow("signer");
  });
  it("blocks old or unknown runtimes and changed call bytes", () => {
    const f = fixture();
    expect(() => assertProposalRuntime(f.api, op)).not.toThrow();
    expect(() =>
      assertProposalRuntime(f.api, { ...op, runtime: undefined }),
    ).toThrow("runtime");
    f.raw.runtimeVersion.specVersion = number(480);
    expect(() => assertProposalRuntime(f.api, op)).toThrow("runtime");
    expect(() =>
      assertProposalRuntime(fixture().api, { ...op, callDataHex: "0x1234" }),
    ).toThrow("hash");
  });
  it("never interprets missing storage or an execute submission as success", async () => {
    expect((await inferPendingOpStatus(fixture().api, op)).status).toBe(
      "needs_review",
    );
    expect(isMultisigExecuted({ op, submitType: "approve_execute" })).toBe(
      false,
    );
    expect(
      getMultisigOutcomeMessage(
        {
          op: { ...op, status: "needs_review" },
          submitType: "approve_execute",
        },
        "Complete",
      ),
    ).toContain("unconfirmed");
  });
  it("refuses to attach a different incarnation of the same call", async () => {
    const f = fixture();
    f.storage.mockResolvedValue({
      isNone: false,
      unwrap: () => ({
        when: { height: number(11), index: number(0) },
        approvals: { toJSON: () => [signatories[0]] },
        depositor: signatories[0],
      }),
    });
    expect((await inferPendingOpStatus(f.api, op)).status).toBe("needs_review");
  });
  it.each(["executed", "cancelled", "failed"] as const)(
    "verifies exact finalized %s receipt",
    async (status) => {
      const f = fixture();
      f.events.push(
        f.event(
          status === "cancelled" ? "MultisigCancelled" : "MultisigExecuted",
          { isOk: status !== "failed", isErr: status === "failed" },
        ),
      );
      expect(await verifyMultisigReceipt(f.api, f.receipt())).toBe(status);
    },
  );
  it("rejects success when an inner batch failed", async () => {
    const f = fixture();
    f.events.push(f.event(), {
      phase: { isApplyExtrinsic: true, asApplyExtrinsic: number(0) },
      event: {
        section: "utility",
        method: "BatchInterrupted",
        data: [number(0), "failure"],
      },
    });
    expect(await verifyMultisigReceipt(f.api, f.receipt())).toBe("failed");
  });
  it("ignores another extrinsic or timepoint", async () => {
    const f = fixture(),
      event = f.event();
    event.phase.asApplyExtrinsic = number(1);
    f.events.push(event);
    expect(await verifyMultisigReceipt(f.api, f.receipt())).toBeNull();
    event.phase.asApplyExtrinsic = number(0);
    event.event.data[1] = { toJSON: () => ({ height: 9, index: 0 }) };
    expect(await verifyMultisigReceipt(f.api, f.receipt())).toBeNull();
  });
  it("rejects noncanonical and unfinalized blocks", async () => {
    const f = fixture();
    f.raw.rpc.chain.getBlockHash.mockResolvedValue({ toHex: () => hash("d") });
    await expect(verifyMultisigReceipt(f.api, f.receipt())).rejects.toThrow(
      "finalized",
    );
    f.raw.rpc.chain.getHeader
      .mockResolvedValueOnce({ number: number(20) })
      .mockResolvedValueOnce({ number: number(21) });
    await expect(verifyMultisigReceipt(f.api, f.receipt())).rejects.toThrow(
      "finalized",
    );
  });
});
