import { describe, expect, it, vi } from "vitest";
import {
  createExitJournal,
  reviewNativeExit,
  assertExitReview,
  type ExitFacts,
  type ExitScope,
} from "../src/exit.ts";
const uuid = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const hash = (n: string) => `0x${n.repeat(64)}`;
const scope: ExitScope = {
  wallet: "5" + "A".repeat(47),
  signer: "5" + "A".repeat(47),
  delegate: "5" + "B".repeat(47),
  genesisHash: hash("a"),
  strategyId: uuid(1),
  generation: uuid(2),
  strategyTable: "custom_strategies",
};
const now = 100000;
const facts = (): ExitFacts => ({
  scope: { ...scope },
  checkedAt: now,
  runtime: "482:1",
  blockHash: hash("b"),
  blockNumber: 100,
  membership: "ended",
  allocation: "quiescent",
  fee: "cleared",
  proxyPresent: true,
  otherProxyDependencies: 0,
  positions: [
    {
      hotkey: "hotkey",
      netuid: 118,
      amountRao: "10000000000000000",
      lockedRao: "0",
    },
  ],
});
function setup() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => {
      data.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      data.delete(k);
    }),
  };
  const coordinator = { run: async <T>(action: () => Promise<T>) => action() };
  return {
    data,
    storage,
    coordinator,
    journal: createExitJournal(storage, uuid(3), scope, coordinator),
  };
}
const receipt = () => ({
  outcome: "succeeded" as const,
  operationId: uuid(3),
  scope,
  transactionHash: hash("c"),
  blockHash: hash("d"),
  callHash: hash("e"),
  innerDispatchVerified: true as const,
});
describe("candidate native exit facts and durable safety state", () => {
  it("membership cessation remains distinct from liquidation and permission revocation", () => {
    const f = facts();
    f.membership = "active";
    f.allocation = "running";
    expect(reviewNativeExit("leave-membership", f, scope, now).intent).toBe(
      "leave-membership",
    );
    expect(f.proxyPresent).toBe(true);
    expect(f.positions[0].amountRao).not.toBe("0");
    expect(() => reviewNativeExit("revoke-authority", f, scope, now)).toThrow(
      /End and verify/,
    );
  });
  it.each(["payment-required", "unknown"] as const)(
    "does not skip %s fee review before leaving",
    (fee) => {
      const f = facts();
      f.membership = "active";
      f.fee = fee;
      expect(() => reviewNativeExit("leave-membership", f, scope, now)).toThrow(
        /fees/,
      );
    },
  );
  it.each(["queued", "running", "submitted", "unknown"] as const)(
    "holds chain changes while allocation is %s",
    (allocation) => {
      const f = facts();
      f.allocation = allocation;
      expect(() => reviewNativeExit("revoke-authority", f, scope, now)).toThrow(
        /Allocation/,
      );
    },
  );
  it.each([1, null])(
    "protects another or unknown shared-proxy dependency %s",
    (otherProxyDependencies) => {
      const f = facts();
      f.otherProxyDependencies = otherProxyDependencies;
      expect(() => reviewNativeExit("revoke-authority", f, scope, now)).toThrow(
        /another membership/,
      );
    },
  );
  it("does not advertise incomplete liquidation or automatically transfer funds", () => {
    expect(() =>
      reviewNativeExit("convert-alpha", facts(), scope, now),
    ).toThrow(/not implemented/);
    expect(() =>
      reviewNativeExit("external-transfer" as never, facts(), scope, now),
    ).toThrow(/Unsupported/);
  });
  it.each([
    "signer",
    "wallet",
    "delegate",
    "genesisHash",
    "generation",
    "strategyId",
  ] as const)("invalidates changed %s", (field) => {
    const f = facts(),
      review = reviewNativeExit("revoke-authority", f, scope, now);
    f.scope[field] = field === "genesisHash" ? hash("f") : "changed";
    expect(() => assertExitReview(review, f, now)).toThrow();
  });
  it.each([
    "runtime",
    "membership",
    "otherProxyDependencies",
    "positions",
  ] as const)("invalidates a material %s change", (field) => {
    const f = facts(),
      review = reviewNativeExit("revoke-authority", f, scope, now);
    if (field === "runtime") f.runtime = "483:1";
    if (field === "membership") f.membership = "active";
    if (field === "otherProxyDependencies") f.otherProxyDependencies = 1;
    if (field === "positions") f.positions = [];
    expect(() => assertExitReview(review, f, now)).toThrow();
  });
  it("expires review and rejects future/stale evidence", () => {
    const f = facts(),
      review = reviewNativeExit("revoke-authority", f, scope, now);
    expect(() => assertExitReview(review, f, now + 60000)).toThrow();
    expect(() =>
      reviewNativeExit("revoke-authority", f, scope, now - 1),
    ).toThrow();
  });
  it("journals before submission and survives reload with duplicate/replay blocked", async () => {
    const { journal, storage, coordinator } = setup(),
      f = facts(),
      review = reviewNativeExit("revoke-authority", f, scope, now);
    await journal.begin(review, f, now, hash("e"));
    const reloaded = createExitJournal(storage, uuid(3), scope, coordinator);
    expect(reloaded.pending()?.state).toBe("needs-review");
    await expect(reloaded.begin(review, f, now, hash("e"))).rejects.toThrow(
      /earlier exit/,
    );
    journal.submitted(hash("c"));
    expect(() => journal.submitted(hash("c"))).toThrow(/duplicate/);
  });
  it("storage failure stops before wallet handoff", async () => {
    const { journal, storage, coordinator } = setup(),
      f = facts();
    storage.setItem.mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(
      journal.begin(
        reviewNativeExit("revoke-authority", f, scope, now),
        f,
        now,
        hash("e"),
      ),
    ).rejects.toThrow(/disk full/);
  });
  it("manual removal updates facts but cannot clear an unknown receipt or replay", async () => {
    const { journal } = setup(),
      f = facts();
    await journal.begin(
      reviewNativeExit("revoke-authority", f, scope, now),
      f,
      now,
      hash("e"),
    );
    f.proxyPresent = false;
    f.positions = [];
    expect(journal.reconcile({ outcome: "unknown" }, f, now)).toMatchObject({
      operation: "needs-review",
      facts: { proxyPresent: false, positions: [] },
    });
    expect(journal.pending()).not.toBeNull();
  });
  it.each(["operationId", "transactionHash", "callHash"] as const)(
    "rejects receipt substitution of %s",
    async (field) => {
      const { journal } = setup(),
        f = facts();
      await journal.begin(
        reviewNativeExit("revoke-authority", f, scope, now),
        f,
        now,
        hash("e"),
      );
      journal.submitted(hash("c"));
      const r = receipt();
      r[field] = field === "operationId" ? uuid(8) : hash("f");
      f.proxyPresent = false;
      expect(() => journal.reconcile(r, f, now)).toThrow(/does not match/);
      expect(journal.pending()).not.toBeNull();
    },
  );
  it("does not treat approval or outer dispatch as finalized proxy removal", async () => {
    const { journal } = setup(),
      f = facts();
    await journal.begin(
      reviewNativeExit("revoke-authority", f, scope, now),
      f,
      now,
      hash("e"),
    );
    expect(() =>
      journal.reconcile(
        { ...receipt(), innerDispatchVerified: false as never },
        f,
        now,
      ),
    ).toThrow();
    expect(journal.reconcile(receipt(), f, now).operation).toBe("needs-review");
    f.proxyPresent = false;
    expect(journal.reconcile(receipt(), f, now).operation).toBe("succeeded");
    expect(journal.pending()).toBeNull();
    expect(f.positions).toHaveLength(1); // Revocation never means liquidation.
  });
  it("retains malformed persisted state instead of silently clearing it", () => {
    const { data, journal, storage } = setup();
    data.set(
      `trustedstake:sdk:exit:v1:pending:${scope.genesisHash}:${scope.wallet}`,
      "{}",
    );
    expect(() => journal.pending()).toThrow();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it("blocks a new operation ID for the same wallet/network and preserves ownership", async () => {
    const { journal, storage, coordinator } = setup(),
      f = facts(),
      review = reviewNativeExit("revoke-authority", f, scope, now);
    await journal.begin(review, f, now, hash("e"));
    const other = createExitJournal(storage, uuid(9), scope, coordinator);
    await expect(other.begin(review, f, now, hash("e"))).rejects.toThrow(
      /earlier exit/,
    );
    expect(() => other.submitted(hash("c"))).toThrow();
    expect(() => other.reconcile(receipt(), f, now)).toThrow(/Another exit/);
    expect(journal.pending()?.operationId).toBe(uuid(3));
  });
  it("does not queue a later prompt when cross-tab ownership is unavailable", async () => {
    const { storage } = setup(),
      f = facts();
    const coordinator = {
      run: async <T>(_action: () => Promise<T>): Promise<T> => {
        throw new Error("Another tab owns operation");
      },
    };
    const journal = createExitJournal(storage, uuid(3), scope, coordinator);
    await expect(
      journal.begin(
        reviewNativeExit("revoke-authority", f, scope, now),
        f,
        now,
        hash("e"),
      ),
    ).rejects.toThrow(/Another tab/);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it.each(["other", null, 1])(
    "rejects malformed receipt outcome %s without clearing",
    async (outcome) => {
      const { journal } = setup(),
        f = facts();
      await journal.begin(
        reviewNativeExit("revoke-authority", f, scope, now),
        f,
        now,
        hash("e"),
      );
      await expect(
        Promise.resolve().then(() =>
          journal.reconcile({ ...receipt(), outcome } as never, f, now),
        ),
      ).rejects.toThrow();
      expect(journal.pending()).not.toBeNull();
    },
  );
  it("revoking owner authority neither settles nor forgives fees", () => {
    const f = facts();
    f.fee = "payment-required";
    expect(reviewNativeExit("revoke-authority", f, scope, now).intent).toBe(
      "revoke-authority",
    );
    expect(f.fee).toBe("payment-required");
  });
});
