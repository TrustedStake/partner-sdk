// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { encodeAddress } from "@polkadot/util-crypto";
import { createPolkadotChainAdapter } from "../src/polkadot/permissions";
import { permissionPlan } from "../src/chain";
import type { JoinContext, Wallet } from "../src/browser";
const hash = (s: string) => "0x" + s.repeat(64),
  walletAddress = encodeAddress(new Uint8Array(32).fill(1), 42),
  proxy = encodeAddress(new Uint8Array(32).fill(2), 42);
function fixture() {
  let granted = false,
    consent: any = { isSome: false, isNone: true },
    height = 10,
    canonical = hash("b");
  const legacy = vi.fn(async () => true),
    v1 = vi.fn(async () => consent);
  const context = { genesisHash: hash("a"), proxy } as JoinContext;
  const wallet: Wallet = {
    genesisHash: hash("a"),
    managedWalletAddress: walletAddress,
    signerAddress: walletAddress,
    signer: {},
    assertCurrentFlow: vi.fn(),
  };
  const events: any[] = [
    {
      phase: {
        isApplyExtrinsic: true,
        asApplyExtrinsic: { toNumber: () => 0 },
      },
      event: { section: "system", method: "ExtrinsicSuccess", data: [] },
    },
  ];
  const snapshot: any = {
    query: {
      proxy: {
        proxies: async () => ({
          toJSON: () => [
            granted
              ? [{ delegate: proxy, proxyType: "Staking", delay: 0 }]
              : [],
            0,
          ],
        }),
        realPaysFeeConsentV1: v1,
        realPaysFee: legacy,
      },
      timestamp: { now: async () => 1000 },
    },
  };
  const calls = {
    addProxy: vi.fn(() => ({ kind: "proxy" })),
    setRealPaysFee: vi.fn(() => ({ kind: "consent" })),
    batchAll: vi.fn((v: any) => ({ calls: v })),
  };
  const api: any = {
    genesisHash: { toHex: () => hash("a") },
    runtimeVersion: {
      specVersion: { toNumber: () => 1 },
      transactionVersion: { toNumber: () => 1 },
    },
    at: vi.fn(async () => snapshot),
    rpc: {
      chain: {
        getFinalizedHead: async () => ({ toHex: () => hash("b") }),
        getHeader: async (arg: any) => ({
          number: typeof arg === "string" ? height : 10,
        }),
        getBlockHash: async () => ({ toHex: () => canonical }),
        getBlock: async () => ({
          block: { extrinsics: [{ hash: { toHex: () => hash("c") } }] },
        }),
      },
    },
    tx: { proxy: calls, utility: calls },
    query: { system: { events: { at: async () => events } } },
  };
  const submit = vi.fn(async (_tx: any, guard: () => Promise<void>) => {
    await guard();
    granted = true;
    consent = { isSome: true, isNone: false };
    return { blockHash: hash("b"), transactionHash: hash("c") };
  });
  return {
    api,
    context,
    wallet,
    submit,
    calls,
    legacy,
    v1,
    snapshot,
    events,
    adapter: createPolkadotChainAdapter(api, submit),
    set consent(v: any) {
      consent = v;
    },
    set height(v: number) {
      height = v;
    },
    set canonical(v: string) {
      canonical = v;
    },
  };
}
describe("concrete finalized permission adapter", () => {
  it("reads proxy, V1 consent and timestamp from one finalized snapshot and atomically submits missing calls", async () => {
    const f = fixture(),
      before = await f.adapter.readPermissions(f.context, f.wallet);
    expect(f.api.at).toHaveBeenCalledWith(hash("b"));
    expect(f.legacy).not.toHaveBeenCalled();
    const plan = permissionPlan(before, f.context, f.wallet, (a, b) => a === b);
    expect(plan).toHaveLength(2);
    const receipt = await f.adapter.submitPermissions(
      plan,
      f.context,
      f.wallet,
    );
    expect(f.calls.batchAll).toHaveBeenCalledTimes(1);
    expect(f.calls.addProxy).toHaveBeenCalledWith(proxy, "Staking", 0);
    expect(f.calls.setRealPaysFee).toHaveBeenCalledWith(proxy, true);
    expect(
      (await f.adapter.readPermissions(f.context, f.wallet, receipt))
        .realPaysFee,
    ).toBe(true);
  });
  it("never substitutes legacy consent when V1 is false", async () => {
    const f = fixture();
    expect(
      (await f.adapter.readPermissions(f.context, f.wallet)).realPaysFee,
    ).toBe(false);
    expect(f.legacy).not.toHaveBeenCalled();
  });
  it.each([{}, undefined, { isSome: true, isNone: true }])(
    "fails closed on malformed consent %j",
    async (value) => {
      const f = fixture();
      f.consent = value;
      await expect(
        f.adapter.readPermissions(f.context, f.wallet),
      ).rejects.toThrow("fee-consent");
    },
  );
  it("rejects future and noncanonical receipt blocks", async () => {
    const f = fixture();
    f.height = 11;
    await expect(
      f.adapter.readPermissions(f.context, f.wallet, {
        blockHash: hash("b"),
        transactionHash: hash("c"),
      }),
    ).rejects.toThrow("finalized");
    f.height = 10;
    f.canonical = hash("d");
    await expect(
      f.adapter.readPermissions(f.context, f.wallet),
    ).rejects.toThrow("canonical");
  });
  it("rejects a changed plan before asking the wallet", async () => {
    const f = fixture();
    await expect(
      f.adapter.submitPermissions(
        [{ kind: "setRealPaysFee", delegate: proxy, value: true }],
        f.context,
        f.wallet,
      ),
    ).rejects.toThrow("plan");
    expect(f.submit).not.toHaveBeenCalled();
  });
  it.each(["ExtrinsicFailed", "BatchInterrupted", "ItemFailed"])(
    "rejects finalized %s despite outer success",
    async (method) => {
      const f = fixture();
      f.events.push({
        phase: {
          isApplyExtrinsic: true,
          asApplyExtrinsic: { toNumber: () => 0 },
        },
        event: {
          section: method === "ExtrinsicFailed" ? "system" : "utility",
          method,
          data: [],
        },
      });
      const plan = permissionPlan(
        await f.adapter.readPermissions(f.context, f.wallet),
        f.context,
        f.wallet,
        (a, b) => a === b,
      );
      await expect(
        f.adapter.submitPermissions(plan, f.context, f.wallet),
      ).rejects.toThrow("dispatch");
      expect(f.submit).toHaveBeenCalledTimes(1);
    },
  );
  it("does not trust a receipt for a different transaction", async () => {
    const f = fixture();
    f.api.rpc.chain.getBlock = async () => ({ block: { extrinsics: [] } });
    const plan = permissionPlan(
      await f.adapter.readPermissions(f.context, f.wallet),
      f.context,
      f.wallet,
      (a, b) => a === b,
    );
    await expect(
      f.adapter.submitPermissions(plan, f.context, f.wallet),
    ).rejects.toThrow("absent");
  });
  it("propagates an uncertain submission without repeating it", async () => {
    const f = fixture();
    f.submit.mockRejectedValueOnce(new Error("connection lost"));
    const plan = permissionPlan(
      await f.adapter.readPermissions(f.context, f.wallet),
      f.context,
      f.wallet,
      (a, b) => a === b,
    );
    await expect(
      f.adapter.submitPermissions(plan, f.context, f.wallet),
    ).rejects.toThrow("connection lost");
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
});
