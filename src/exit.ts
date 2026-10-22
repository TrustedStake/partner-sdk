import type { MutationCoordinator } from "./ownership.ts";
import type { Storage } from "./types.ts";
import { HASH, UUID } from "./contracts.ts";

// Internal candidate contract. Not exported by the published package entrypoints.
// Native wire/chain adapters must supply verified evidence before this can ship.
export type ExitIntent =
  | "leave-membership"
  | "revoke-authority"
  | "convert-alpha";
export interface ExitScope {
  wallet: string;
  signer: string;
  genesisHash: string;
  strategyId: string;
  strategyTable: "strategies" | "custom_strategies";
  generation: string;
  delegate: string;
}
export interface ExitFacts {
  scope: ExitScope;
  runtime: string;
  blockHash: string;
  blockNumber: number;
  checkedAt: number;
  membership: "active" | "ended" | "unknown";
  allocation: "quiescent" | "queued" | "running" | "submitted" | "unknown";
  fee: "cleared" | "payment-required" | "unknown";
  proxyPresent: boolean | "unknown";
  otherProxyDependencies: number | null;
  positions: readonly {
    hotkey: string;
    netuid: number;
    amountRao: string;
    lockedRao: string;
  }[];
}
export interface ExitReview {
  intent: ExitIntent;
  scope: ExitScope;
  runtime: string;
  blockHash: string;
  blockNumber: number;
  expiresAt: number;
  factsKey: string;
}
export interface ExitPending {
  version: 1;
  operationId: string;
  review: ExitReview;
  state: "needs-review" | "submitted";
  transactionHash?: string;
  callHash: string;
}
export type CanonicalExitReceipt =
  | { outcome: "unknown" }
  | {
      outcome: "failed";
      operationId: string;
      scope: ExitScope;
      callHash: string;
      transactionHash: string;
      blockHash: string;
      innerDispatchVerified: true;
    }
  | {
      outcome: "succeeded";
      operationId: string;
      scope: ExitScope;
      callHash: string;
      transactionHash: string;
      blockHash: string;
      innerDispatchVerified: true;
    };
const u64 = (value: string) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("Invalid exit amount.");
  const n = BigInt(value);
  if (n > (1n << 64n) - 1n) throw new Error("Invalid exit amount.");
  return n;
};
export function sameExitScope(a: ExitScope, b: ExitScope): boolean {
  // Adapters normalize SS58 addresses before creating a scope.
  return [
    "wallet",
    "signer",
    "genesisHash",
    "strategyId",
    "strategyTable",
    "generation",
    "delegate",
  ].every((key) => a[key as keyof ExitScope] === b[key as keyof ExitScope]);
}
function assertFacts(facts: ExitFacts, scope: ExitScope, now: number) {
  if (
    ![scope.wallet, scope.signer, scope.delegate].every((a) =>
      /^[1-9A-HJ-NP-Za-km-z]{47,50}$/.test(a),
    ) ||
    !sameExitScope(facts.scope, scope) ||
    !UUID.test(scope.strategyId) ||
    !UUID.test(scope.generation) ||
    !["strategies", "custom_strategies"].includes(scope.strategyTable) ||
    !HASH.test(scope.genesisHash) ||
    !HASH.test(facts.blockHash) ||
    !facts.runtime ||
    facts.runtime.length > 100 ||
    !Number.isSafeInteger(facts.blockNumber) ||
    facts.blockNumber < 0 ||
    !Number.isSafeInteger(facts.checkedAt) ||
    !Number.isSafeInteger(now) ||
    now < facts.checkedAt ||
    now - facts.checkedAt > 60_000 ||
    !["active", "ended", "unknown"].includes(facts.membership) ||
    !["quiescent", "queued", "running", "submitted", "unknown"].includes(
      facts.allocation,
    ) ||
    !["cleared", "payment-required", "unknown"].includes(facts.fee) ||
    ![true, false, "unknown"].includes(facts.proxyPresent) ||
    (facts.otherProxyDependencies !== null &&
      (!Number.isSafeInteger(facts.otherProxyDependencies) ||
        facts.otherProxyDependencies < 0)) ||
    !Array.isArray(facts.positions) ||
    facts.positions.length > 10000
  )
    throw new Error("Exit evidence is missing, changed or stale.");
  const seen = new Set<string>();
  for (const p of facts.positions) {
    const key = `${p.hotkey}:${p.netuid}`;
    if (
      !p.hotkey ||
      p.hotkey.length > 128 ||
      !Number.isSafeInteger(p.netuid) ||
      p.netuid < 0 ||
      p.netuid > 65535 ||
      seen.has(key) ||
      u64(p.lockedRao) > u64(p.amountRao)
    )
      throw new Error("Invalid exit holdings.");
    seen.add(key);
  }
}
function factsKey(facts: ExitFacts): string {
  return JSON.stringify([
    facts.scope,
    facts.runtime,
    facts.membership,
    facts.allocation,
    facts.fee,
    facts.proxyPresent,
    facts.otherProxyDependencies,
    facts.positions
      .map((p) => [p.hotkey, p.netuid, p.amountRao, p.lockedRao])
      .sort(),
  ]);
}
/** This planner never signs, cancels a chain operation or interprets membership as liquidation. */
export function reviewNativeExit(
  intent: ExitIntent,
  facts: ExitFacts,
  scope: ExitScope,
  now: number,
): ExitReview {
  assertFacts(facts, scope, now);
  if (
    !["leave-membership", "revoke-authority", "convert-alpha"].includes(intent)
  )
    throw new Error("Unsupported exit intent.");
  if (facts.membership === "unknown")
    throw new Error("Membership needs reconciliation.");
  if (intent === "leave-membership") {
    if (facts.membership !== "active")
      throw new Error("Membership has already ended.");
    if (facts.fee !== "cleared") throw new Error("Review exit fees first.");
    // Stopping membership is allowed while work is pending; that does not cancel work or complete an exit.
  } else {
    if (facts.membership !== "ended")
      throw new Error(
        "End and verify membership before reviewing chain changes.",
      );
    if (facts.allocation !== "quiescent")
      throw new Error("Allocation is still pending or unknown.");
    if (intent === "revoke-authority") {
      // Owner permission revocation does not pay or forgive outstanding invoices.
      // Preserve fee facts; do not turn debt into a new block on stopping authority.
      if (facts.proxyPresent !== true || facts.otherProxyDependencies !== 0)
        throw new Error(
          "Proxy is absent, unverified or needed by another membership.",
        );
    } else {
      // Conversion quoting/submission remains deliberately unavailable until the
      // bounded quote, partial-fill and canonical dispatch adapters are implemented.
      throw new Error("Native liquidation adapter is not implemented.");
    }
  }
  return {
    intent,
    scope: structuredClone(scope),
    runtime: facts.runtime,
    blockHash: facts.blockHash,
    blockNumber: facts.blockNumber,
    expiresAt: now + 60_000,
    factsKey: factsKey(facts),
  };
}
export function assertExitReview(
  review: ExitReview,
  facts: ExitFacts,
  now: number,
) {
  // Re-run semantic preconditions, not only a caller-supplied fingerprint.
  reviewNativeExit(review.intent, facts, review.scope, now);
  if (
    now >= review.expiresAt ||
    now < review.expiresAt - 60_000 ||
    facts.runtime !== review.runtime ||
    factsKey(facts) !== review.factsKey
  )
    throw new Error("Exit review changed or expired.");
}
function pendingValue(value: unknown, scope: ExitScope): ExitPending {
  if (!value || typeof value !== "object")
    throw new Error("Exit journal needs review.");
  const p = value as ExitPending;
  if (
    p.version !== 1 ||
    !UUID.test(p.operationId) ||
    !HASH.test(p.callHash) ||
    !["needs-review", "submitted"].includes(p.state) ||
    !p.review ||
    !sameExitScope(p.review.scope, scope) ||
    !["leave-membership", "revoke-authority"].includes(p.review.intent) ||
    !HASH.test(p.review.blockHash) ||
    !Number.isSafeInteger(p.review.expiresAt) ||
    typeof p.review.factsKey !== "string" ||
    (p.transactionHash !== undefined && !HASH.test(p.transactionHash))
  )
    throw new Error("Exit journal needs review.");
  return p;
}
/** Journal state is never a receipt. Uncertain work survives reload, dismissal and manual completion. */
export function createExitJournal(
  storage: Storage,
  operationId: string,
  scope: ExitScope,
  coordinator: MutationCoordinator,
) {
  if (
    !UUID.test(operationId) ||
    !coordinator ||
    typeof coordinator.run !== "function"
  )
    throw new Error("Invalid exit operation.");
  // One durable exclusion per normalized wallet/network, including across operations.
  const key = `trustedstake:sdk:exit:v1:pending:${scope.genesisHash}:${scope.wallet}`;
  const read = (): ExitPending | null => {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    if (raw.length > 1_000_000) throw new Error("Exit journal needs review.");
    return pendingValue(JSON.parse(raw), scope);
  };
  return {
    pending: read,
    async begin(
      review: ExitReview,
      facts: ExitFacts,
      now: number,
      callHash: string,
    ) {
      return coordinator.run(async () => {
        if (read())
          throw new Error(
            "Reconcile the earlier exit before another submission.",
          );
        if (!HASH.test(callHash) || !sameExitScope(review.scope, scope))
          throw new Error("Exit scope changed.");
        assertExitReview(review, facts, now);
        // Synchronous durable storage failure must stop the caller before its wallet request.
        storage.setItem(
          key,
          JSON.stringify({
            version: 1,
            operationId,
            review,
            callHash,
            state: "needs-review",
          } satisfies ExitPending),
        );
      });
    },
    submitted(transactionHash: string) {
      const pending = read();
      if (
        !pending ||
        pending.operationId !== operationId ||
        !HASH.test(transactionHash) ||
        pending.transactionHash
      )
        throw new Error("Invalid or duplicate exit submission.");
      storage.setItem(
        key,
        JSON.stringify({ ...pending, state: "submitted", transactionHash }),
      );
    },
    reconcile(receipt: CanonicalExitReceipt, facts: ExitFacts, now: number) {
      const pending = read();
      if (!pending) return { operation: "none" as const, facts };
      assertFacts(facts, scope, now);
      if (pending.operationId !== operationId)
        throw new Error("Another exit owns this journal.");
      if (receipt.outcome === "unknown")
        return { operation: "needs-review" as const, facts };
      if (
        !["succeeded", "failed"].includes(receipt.outcome) ||
        receipt.operationId !== operationId ||
        !sameExitScope(receipt.scope, scope) ||
        receipt.callHash !== pending.callHash ||
        receipt.innerDispatchVerified !== true ||
        !HASH.test(receipt.transactionHash) ||
        !HASH.test(receipt.blockHash) ||
        (pending.transactionHash &&
          receipt.transactionHash !== pending.transactionHash)
      )
        throw new Error("Exit receipt does not match.");
      // Caller must provide the canonical, exact-call-bound adapter result. The first
      // slice only reconciles chain proxy revocation; membership needs API receipt binding.
      if (pending.review.intent !== "revoke-authority")
        throw new Error("Membership receipt adapter is not implemented.");
      if (receipt.outcome === "succeeded" && facts.proxyPresent !== false)
        return { operation: "needs-review" as const, facts };
      storage.removeItem(key);
      return { operation: receipt.outcome, facts };
    },
  };
}
