import { describe, it, expect, vi } from "vitest";
import { parseExitCheckout } from "../src/exit-api.ts";
import {
  validateNativeExitRequest,
  createNativeExitBridge,
} from "../src/exit-bridge.ts";
import { createExitWalletSubmitter } from "../src/polkadot/exit-wallet.ts";
import { isExitBeforeBroadcast } from "../src/exit-submission.ts";
const id = "00000000-0000-4000-8000-000000000001",
  a = "5" + "a".repeat(47),
  b = "5" + "b".repeat(47),
  hash = "0x" + "1".repeat(64),
  now = 1700000000000;
const scope = {
  wallet: a,
  signer: a,
  delegate: b,
  genesisHash: hash,
  strategyId: id,
  strategyTable: "custom_strategies" as const,
  generation: id,
};
function quote() {
  return {
    required: true,
    bundleId: id,
    strategyId: id,
    memberSs58: a,
    network: { name: "finney", genesisHash: hash },
    transfers: [{ ss58: b, amountRao: "100" }],
    totalAmountRao: "100",
    paymentReferenceHash: hash,
    quoteExpiresAt: new Date(now + 60000).toISOString(),
    reviewItems: [],
    extrinsicRecipe: {
      kind: "BATCH_ALL_V1",
      calls: [
        { pallet: "balances", method: "transferKeepAlive", args: [b, "100"] },
        { pallet: "system", method: "remarkWithEvent", args: [hash] },
      ],
    },
  };
}
const same = (x: string, y: string) =>
  /^[1-9A-HJ-NP-Za-km-z]{47,50}$/.test(x) && x === y;
describe("Native exit financial and forwarding boundaries", () => {
  it.each([
    "recipient",
    "amount",
    "remark",
    "expiry",
    "genesis",
    "total",
  ] as const)("rejects changed %s before signing", (kind) => {
    const q = quote();
    if (kind === "recipient") q.extrinsicRecipe.calls[0].args[0] = a;
    if (kind === "amount") q.extrinsicRecipe.calls[0].args[1] = "99";
    if (kind === "remark")
      q.extrinsicRecipe.calls[1].args[0] = "0x" + "2".repeat(64);
    if (kind === "expiry") q.quoteExpiresAt = new Date(now).toISOString();
    if (kind === "genesis") q.network.genesisHash = "0x" + "2".repeat(64);
    if (kind === "total") q.totalAmountRao = "101";
    expect(() => parseExitCheckout(q, scope, same, now)).toThrow();
  });
  it("accepts only the disclosed transfers and remark", () => {
    expect(parseExitCheckout(quote(), scope, same, now).totalAmountRao).toBe(
      "100",
    );
  });
  it.each([
    "membership/register",
    "fees/me/bundles/" + id + "/refund",
    "partners/admin",
    "https://elsewhere.invalid/partners/public/" +
      id +
      "/connections/challenges",
  ])("does not proxy %s", (path) => {
    expect(() =>
      validateNativeExitRequest("POST", path, {}, new Headers()),
    ).toThrow();
  });
  it("never forwards cookies/server keys and requires host authorization", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { ok: true },
        { headers: { "set-cookie": "not-forwarded" } },
      ),
    );
    const path = `/exit/partners/public/${id}/connections/exit-context?strategyId=${id}&strategyTable=custom_strategies&proxy=${b}`;
    const request = () =>
      new Request("https://partner.invalid" + path, {
        headers: {
          authorization: `Bearer tse_${id}_${"a".repeat(64)}`,
          cookie: "private-session",
          "x-api-key": "forbidden",
        },
      });
    const denied = createNativeExitBridge({
      apiOrigin: "https://api.invalid",
      prefix: "/exit",
      fetch: fetch as typeof globalThis.fetch,
      authorize: async () => false,
    });
    expect((await denied(request())).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    const allowed = createNativeExitBridge({
      apiOrigin: "https://api.invalid",
      prefix: "/exit",
      fetch: fetch as typeof globalThis.fetch,
      authorize: async () => true,
    });
    const reply = await allowed(request());
    expect(reply.status).toBe(200);
    expect(reply.headers.has("set-cookie")).toBe(false);
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(call[1].headers);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("x-api-key")).toBe(false);
    expect(call[1].redirect).toBe("error");
    expect(call[1].credentials).toBe("omit");
  });
  it("checks before and after wallet signing, journals hash before broadcast", async () => {
    const order: string[] = [];
    const tx = {
      hash: { toHex: () => hash },
      signAsync: async () => {
        order.push("sign");
      },
      send: (callback: any) => {
        order.push("send");
        callback({
          status: { isFinalized: true, asFinalized: { toHex: () => hash } },
        });
        return Promise.resolve(() => {
          order.push("unsubscribe");
        });
      },
    };
    const submit = createExitWalletSubmitter(a, {} as any, () => {});
    const receipt = await submit(
      tx,
      async () => {
        order.push("guard");
      },
      () => {
        order.push("journal");
      },
    );
    expect(receipt.transactionHash).toBe(hash);
    expect(order.slice(0, 5)).toEqual([
      "guard",
      "sign",
      "guard",
      "journal",
      "send",
    ]);
  });
  it("classifies only errors proven before send as retryable", async () => {
    const send = vi.fn(),
      tx = { hash: { toHex: () => hash }, signAsync: async () => {}, send };
    let checks = 0;
    const submit = createExitWalletSubmitter(a, {} as any, () => {});
    let failure: unknown;
    try {
      await submit(
        tx,
        async () => {
          if (++checks === 2) throw new Error("Account changed");
        },
        () => {},
      );
    } catch (e) {
      failure = e;
    }
    expect(isExitBeforeBroadcast(failure)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    send.mockImplementation(() => {
      throw new Error("Transport failed after invocation");
    });
    checks = 0;
    try {
      await submit(
        tx,
        async () => {},
        () => {},
      );
    } catch (e) {
      failure = e;
    }
    expect(isExitBeforeBroadcast(failure)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
