import { describe, it, expect, vi } from "vitest";
import { encodeAddress, blake2AsHex } from "@polkadot/util-crypto";
import { createPolkadotNativeExitAdapter } from "../src/polkadot/native-exit.ts";
import type { ExitScope, ExitPending } from "../src/exit.ts";

const wallet = encodeAddress(new Uint8Array(32).fill(1), 42),
  hotkey = encodeAddress(new Uint8Array(32).fill(2), 42),
  delegate = encodeAddress(new Uint8Array(32).fill(3), 42);
const hash = (n: string) => `0x${n.repeat(64)}`;
const scope: ExitScope = {
  wallet,
  signer: wallet,
  delegate,
  genesisHash: hash("1"),
  strategyId: "00000000-0000-4000-8000-000000000001",
  strategyTable: "custom_strategies",
  generation: "00000000-0000-4000-8000-000000000002",
};
const pending = (callHash: string, transactionHash?: string): ExitPending => ({
  version: 1,
  operationId: "00000000-0000-4000-8000-000000000003",
  state: transactionHash ? "submitted" : "needs-review",
  transactionHash,
  callHash,
  review: {
    intent: "convert-alpha",
    scope,
    runtime: "482:1",
    blockHash: hash("1"),
    blockNumber: 99,
    expiresAt: 61000,
    factsKey: "fixture",
  },
});
function fixture() {
  let clock = 1000;
  const codec = (v: unknown) => ({
    toJSON: () => v,
    toString: () => String(v),
    toNumber: () => Number(v),
  });
  const state = {
    stake: "1000000000",
    locked: "0",
    price: "1000000000",
    enabled: true,
    output: "990000000",
    proxy: true,
  };
  const tx =
    (name: string) =>
    (...args: unknown[]) => {
      const hex = `0x${Buffer.from(JSON.stringify([name, args])).toString("hex")}`;
      return { method: { toHex: () => hex } };
    };
  const remove = vi.fn(tx("removeStake")),
    limit = vi.fn(tx("removeStakeLimit"));
  const at = {
    call: {
      stakeInfoRuntimeApi: {
        getStakeInfoForColdkey: async () =>
          codec([
            {
              coldkey: wallet,
              hotkey,
              netuid: 1,
              stake: state.stake,
              locked: state.locked,
            },
          ]),
      },
      swapRuntimeApi: {
        currentAlphaPrice: async () => codec(state.price),
        simSwapAlphaForTao: async () =>
          codec({ alphaFee: "0", taoFee: "0", taoAmount: state.output }),
      },
    },
    query: {
      proxy: {
        proxies: async () =>
          codec([
            state.proxy ? [{ delegate, proxyType: "Staking", delay: 0 }] : [],
            0,
          ]),
      },
      subtensorModule: { subtokenEnabled: async () => codec(state.enabled) },
    },
    consts: { subtensorModule: { initialMinStake: codec("1000") } },
  };
  const api = {
    genesisHash: { toHex: () => scope.genesisHash },
    runtimeVersion: { specVersion: codec(482), transactionVersion: codec(1) },
    at: async () => at,
    rpc: {
      state: { getRuntimeVersion: async () => api.runtimeVersion },
      chain: {
        getFinalizedHead: async () => ({ toHex: () => hash("2") }),
        getHeader: async () => ({
          number: { toString: () => "100", toBigInt: () => 100n },
        }),
        getBlockHash: async () => ({ toHex: () => hash("2") }),
        getBlock: vi.fn(),
      },
    },
    query: { system: { events: { at: vi.fn() } } },
    tx: {
      proxy: { removeProxy: vi.fn(tx("removeProxy")) },
      utility: { batchAll: tx("batchAll") },
      subtensorModule: { removeStake: remove, removeStakeLimit: limit },
    },
  };
  const adapter = createPolkadotNativeExitAdapter(api as any, () => clock);
  const selected = [{ hotkey, netuid: 1, amountRao: "1000000000" }];
  return {
    api,
    adapter,
    state,
    selected,
    remove,
    limit,
    setTime: (n: number) => {
      clock = n;
    },
  };
}
describe("Concrete native exit chain adapter (synthetic RPC, no signing)", () => {
  it("encodes the exact user-selected protected limit and partial policy; never adds a transfer", async () => {
    const f = fixture(),
      authority = vi.fn(async () => {});
    const r = await f.adapter.prepareConversion(
      scope,
      f.selected,
      160,
      false,
      authority,
    );
    expect(f.limit).toHaveBeenCalledWith(
      hotkey,
      1,
      "1000000000",
      "984000000",
      false,
    );
    expect(r.quote.skipped).toEqual([]);
    expect(r.quote.executable).toHaveLength(1);
    expect(r.callHash).toBe(blake2AsHex(r.callDataHex, 256));
    await r.assertCurrent();
    expect(authority).toHaveBeenCalledTimes(2);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("fails closed on a rounded-to-zero price, absent protected runtime call or malformed amount", async () => {
    const f = fixture();
    f.state.price = "1";
    await expect(
      f.adapter.prepareConversion(
        scope,
        f.selected,
        9999,
        false,
        async () => {},
      ),
    ).rejects.toThrow("nonzero");
    f.state.price = "1000000000";
    (f.api.tx.subtensorModule as any).removeStakeLimit = undefined;
    await expect(
      f.adapter.prepareConversion(
        scope,
        f.selected,
        160,
        false,
        async () => {},
      ),
    ).rejects.toThrow("unavailable");
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("does not loosen a rejected quote or approve partial fills automatically", async () => {
    const f = fixture();
    f.state.output = "800000000";
    await expect(
      f.adapter.prepareConversion(
        scope,
        f.selected,
        160,
        false,
        async () => {},
      ),
    ).rejects.toThrow("No selected");
    expect(f.limit).not.toHaveBeenCalled();
    const r = await f.adapter.prepareConversion(
      scope,
      f.selected,
      160,
      true,
      async () => {},
    );
    expect(r.quote.allowPartial).toBe(true);
    expect(f.limit).toHaveBeenLastCalledWith(
      hotkey,
      1,
      "1000000000",
      "984000000",
      true,
    );
  });
  it("rechecks holdings, runtime, expiry and owner-authority at the signing boundary", async () => {
    const f = fixture();
    const r = await f.adapter.prepareConversion(
      scope,
      f.selected,
      160,
      false,
      async () => {},
    );
    f.state.stake = "900000000";
    await expect(r.assertCurrent()).rejects.toThrow("holdings changed");
    f.state.stake = "1000000000";
    f.setTime(r.quote.expiresAt);
    await expect(r.assertCurrent()).rejects.toThrow("expired");
    const g = fixture();
    const revoke = await g.adapter.prepareRevocation(scope, async () => {});
    g.state.proxy = false;
    await expect(revoke.assertCurrent()).rejects.toThrow("authority changed");
  });
  it("does not build a call for locked holdings or duplicate positions", async () => {
    const f = fixture();
    f.state.locked = "1";
    await expect(
      f.adapter.prepareConversion(
        scope,
        f.selected,
        160,
        false,
        async () => {},
      ),
    ).rejects.toThrow("No selected");
    f.state.locked = "0";
    await expect(
      f.adapter.prepareConversion(
        scope,
        [...f.selected, ...f.selected],
        160,
        false,
        async () => {},
      ),
    ).rejects.toThrow("Invalid selected");
  });
  it("binds canonical direct receipts to exact wallet/call and records failed dispatch", async () => {
    const f = fixture(),
      r = await f.adapter.prepareConversion(
        scope,
        f.selected,
        160,
        false,
        async () => {},
      ),
      txHash = hash("3");
    f.api.rpc.chain.getBlock.mockResolvedValue({
      block: {
        extrinsics: [
          {
            isSigned: true,
            signer: { toString: () => wallet },
            hash: { toHex: () => txHash },
            method: { toHex: () => r.callDataHex },
          },
        ],
      },
    });
    f.api.query.system.events.at.mockResolvedValue([
      {
        phase: {
          isApplyExtrinsic: true,
          asApplyExtrinsic: { toNumber: () => 0 },
        },
        event: { section: "system", method: "ExtrinsicFailed", data: [] },
      },
    ]);
    const receipt = await f.adapter.receipt(
      pending(r.callHash, txHash),
      txHash,
      hash("2"),
    );
    expect(receipt.outcome).toBe("failed");
    await expect(
      f.adapter.receipt(pending(hash("9"), txHash), txHash, hash("2")),
    ).rejects.toThrow("reviewed wallet call");
  });
  it("rejects a call mutated during an asynchronous signing-boundary check", async () => {
    const f = fixture();
    let mutate = false;
    let r: Awaited<ReturnType<typeof f.adapter.prepareConversion>>;
    r = await f.adapter.prepareConversion(
      scope,
      f.selected,
      160,
      false,
      async () => {
        if (mutate) (r.transaction.method as any).toHex = () => hash("9");
      },
    );
    mutate = true;
    await expect(r.assertCurrent()).rejects.toThrow("changed");
  });
  it("rejects runtime transitions during read and historical receipt substitution", async () => {
    const f = fixture(),
      original = f.api.at;
    f.api.at = async () => {
      const at = await original();
      f.api.runtimeVersion.specVersion = {
        toJSON: () => 483,
        toString: () => "483",
        toNumber: () => 483,
      };
      return at;
    };
    await expect(f.adapter.read(scope)).rejects.toThrow("runtime changed");
    const g = fixture(),
      old = pending(hash("4"), hash("3"));
    old.review.blockNumber = 100;
    expect(await g.adapter.receipt(old, hash("3"), hash("2"))).toEqual({
      outcome: "unknown",
    });
  });
  it("freezes reviewed selection before awaits and keeps display data out of preflight ownership", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selected = structuredClone(f.selected);
    const result = f.adapter.prepareConversion(
      scope,
      selected,
      160,
      false,
      async () => {
        await gate;
      },
    );
    selected[0].amountRao = "1";
    selected.push(...Array.from({ length: 9 }, () => ({ ...selected[0] })));
    release();
    const review = await result;
    expect(review.quote.selected).toHaveLength(1);
    expect(review.quote.selected[0].amountRao).toBe("1000000000");
    expect(() => {
      review.quote.executable.length = 0;
    }).toThrow();
    f.state.stake = "1";
    await expect(review.assertCurrent()).rejects.toThrow("holdings changed");
  });
  it("never interprets a missing receipt as permission to resubmit", async () => {
    const f = fixture();
    f.api.rpc.chain.getBlock.mockResolvedValue({ block: { extrinsics: [] } });
    expect(
      await f.adapter.receipt(pending(hash("4")), hash("3"), hash("2")),
    ).toEqual({ outcome: "unknown" });
  });
});
