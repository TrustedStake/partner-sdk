import type { MutationCoordinator } from "./ownership.ts";
import type { Storage } from "./types.ts";
import { HASH, UUID } from "./contracts.ts";

// Versioned native-exit contract. Journal state alone is never canonical execution proof.
export type ExitIntent =
  | "cancel-proposal"
  | "pay-exit-fees"
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
  otherActiveMemberships: number | null;
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
  state: "needs-review" | "submitted" | "awaiting-signers";
  details?: {
    feeBundleId?: string;
    originalReview?: ExitReview;
    feeCheckout?: import("./exit-api.ts").ExitCheckout;
    multisig?: import("./polkadot/types.ts").PendingMultisigOp;
  };
  transactionHash?: string;
  callHash: string;
}
export interface ExitApproval {
  operationId: string;
  scope: ExitScope;
  callHash: string;
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
  extrinsicIndex: number;
  approvalVerified: true;
  operation: import("./polkadot/types.ts").PendingMultisigOp;
}
export type CanonicalExitReceipt =
  | { outcome: "unknown" }
  | {
      outcome: "failed" | "cancelled";
      operationId: string;
      scope: ExitScope;
      callHash: string;
      transactionHash: string;
      blockHash: string;
      blockNumber: number;
      extrinsicIndex: number;
      innerDispatchVerified: true;
      /** Canonical settlement of an already verified proposal executed/cancelled by another signer. */
      observedProposal?: { height: number; index: number };
    }
  | {
      outcome: "succeeded";
      operationId: string;
      scope: ExitScope;
      callHash: string;
      transactionHash: string;
      blockHash: string;
      blockNumber: number;
      extrinsicIndex: number;
      innerDispatchVerified: true;
      /** Canonical settlement of an already verified proposal executed/cancelled by another signer. */
      observedProposal?: { height: number; index: number };
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
export function sameExitTarget(a: ExitScope, b: ExitScope): boolean {
  return sameExitScope({ ...a, signer: b.signer }, b);
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
    (facts.otherActiveMemberships !== null &&
      (!Number.isSafeInteger(facts.otherActiveMemberships) ||
        facts.otherActiveMemberships < 0)) ||
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
    facts.otherActiveMemberships,
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
    ![
      "cancel-proposal",
      "pay-exit-fees",
      "leave-membership",
      "revoke-authority",
      "convert-alpha",
    ].includes(intent)
  )
    throw new Error("Unsupported exit intent.");
  if (facts.membership === "unknown" && intent !== "cancel-proposal")
    throw new Error("Membership needs reconciliation.");
  if (intent === "cancel-proposal") {
    // Depositor cancellation is checked against the exact live proposal by the adapter.
  } else if (intent === "pay-exit-fees") {
    if (facts.fee !== "payment-required")
      throw new Error("No reviewed exit fee payment is required.");
  } else if (intent === "leave-membership") {
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
      if (
        facts.proxyPresent !== false ||
        facts.otherActiveMemberships !== 0 ||
        facts.fee !== "cleared"
      )
        throw new Error(
          "Verify fees, remaining memberships and revoked authority before conversion.",
        );
      if (!facts.positions.some((p) => u64(p.amountRao) > 0n))
        throw new Error("No alpha holdings remain to convert.");
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
    !["needs-review", "submitted", "awaiting-signers"].includes(p.state) ||
    !p.review ||
    !sameExitTarget(p.review.scope, scope) ||
    ![
      "cancel-proposal",
      "pay-exit-fees",
      "leave-membership",
      "revoke-authority",
      "convert-alpha",
    ].includes(p.review.intent) ||
    !HASH.test(p.review.blockHash) ||
    !Number.isSafeInteger(p.review.expiresAt) ||
    typeof p.review.factsKey !== "string" ||
    (p.transactionHash !== undefined && !HASH.test(p.transactionHash))
  )
    throw new Error("Exit journal needs review.");
  if (
    p.details &&
    (typeof p.details !== "object" ||
      Object.keys(p.details).some(
        (k) =>
          ![
            "feeBundleId",
            "feeCheckout",
            "multisig",
            "originalReview",
          ].includes(k),
      ) ||
      (p.details.feeBundleId !== undefined &&
        !UUID.test(p.details.feeBundleId)))
  )
    throw new Error("Exit journal details need review.");
  if (p.details?.multisig) {
    const op = p.details.multisig;
    if (
      op.chainId !== scope.genesisHash ||
      op.managedAccount !== scope.wallet ||
      op.multisigAddress !== scope.wallet ||
      op.callHashHex !== p.callHash ||
      op.authorizationProof ||
      typeof op.callDataHex !== "string" ||
      !/^0x(?:[0-9a-f]{2}){1,160000}$/i.test(op.callDataHex)
    )
      throw new Error("Multisig exit journal does not match.");
  }
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
      details?: ExitPending["details"],
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
            ...(details ? { details: structuredClone(details) } : {}),
          } satisfies ExitPending),
        );
      });
    },
    reconcileMembership(facts: ExitFacts, now: number) {
      const pending = read();
      assertFacts(facts, scope, now);
      if (!pending) return { operation: "none" as const, facts };
      if (
        pending.operationId !== operationId ||
        pending.review.intent !== "leave-membership" ||
        !sameExitTarget(pending.review.scope, scope)
      )
        throw new Error("Membership operation does not match.");
      if (facts.membership !== "ended")
        return { operation: "needs-review" as const, facts };
      storage.removeItem(key);
      return { operation: "succeeded" as const, facts };
    },
    recordApproval(receipt: ExitApproval) {
      const pending = read();
      if (
        !pending ||
        pending.operationId !== operationId ||
        receipt.operationId !== operationId ||
        receipt.approvalVerified !== true ||
        !sameExitScope(receipt.scope, pending.review.scope) ||
        receipt.transactionHash !== pending.transactionHash ||
        receipt.callHash !== pending.callHash ||
        receipt.blockNumber <= pending.review.blockNumber ||
        !receipt.operation.timepoint ||
        receipt.operation.callHashHex !== pending.callHash ||
        receipt.operation.chainId !== scope.genesisHash ||
        receipt.operation.managedAccount !== scope.wallet
      )
        throw new Error("Multisig approval receipt does not match.");
      storage.setItem(
        key,
        JSON.stringify({
          ...pending,
          state: "awaiting-signers",
          transactionHash: undefined,
          details: { ...pending.details, multisig: receipt.operation },
        }),
      );
    },
    async continueReview(
      review: ExitReview,
      facts: ExitFacts,
      now: number,
      callHash: string,
    ) {
      return coordinator.run(async () => {
        const pending = read();
        if (
          !pending ||
          pending.operationId !== operationId ||
          pending.state !== "awaiting-signers" ||
          pending.transactionHash ||
          !pending.details?.multisig?.timepoint ||
          (pending.review.intent !== review.intent &&
            review.intent !== "cancel-proposal") ||
          pending.callHash !== callHash ||
          !sameExitTarget(review.scope, scope)
        )
          throw new Error("Multisig continuation changed or is unresolved.");
        assertExitReview(review, facts, now);
        storage.setItem(
          key,
          JSON.stringify({
            ...pending,
            review,
            state: "needs-review",
            details: {
              ...pending.details,
              ...(review.intent === "cancel-proposal"
                ? { originalReview: pending.review }
                : {}),
            },
          }),
        );
      });
    },
    restoreUnsent() {
      const pending = read();
      if (!pending || pending.operationId !== operationId)
        throw new Error("Exit operation does not match.");
      // Only call with submitter proof that send was never invoked. A recorded
      // signed hash may exist if the guard/storage handoff itself failed.
      if (pending.details?.multisig?.timepoint)
        storage.setItem(
          key,
          JSON.stringify({
            ...pending,
            review: pending.details.originalReview ?? pending.review,
            state: "awaiting-signers",
            transactionHash: undefined,
            details: { ...pending.details, originalReview: undefined },
          }),
        );
      else storage.removeItem(key);
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
        !["succeeded", "failed", "cancelled"].includes(receipt.outcome) ||
        receipt.operationId !== operationId ||
        !sameExitScope(receipt.scope, pending.review.scope) ||
        receipt.callHash !== pending.callHash ||
        receipt.innerDispatchVerified !== true ||
        !HASH.test(receipt.transactionHash) ||
        !HASH.test(receipt.blockHash) ||
        !Number.isSafeInteger(receipt.blockNumber) ||
        receipt.blockNumber <= pending.review.blockNumber ||
        !Number.isSafeInteger(receipt.extrinsicIndex) ||
        receipt.extrinsicIndex < 0 ||
        (pending.transactionHash &&
          receipt.transactionHash !== pending.transactionHash)
      )
        throw new Error("Exit receipt does not match.");
      const observed =
        pending.state === "awaiting-signers" &&
        !pending.transactionHash &&
        !!pending.details?.multisig?.timepoint &&
        !!receipt.observedProposal &&
        pending.details.multisig.timepoint.height ===
          receipt.observedProposal.height &&
        pending.details.multisig.timepoint.index ===
          receipt.observedProposal.index;
      if (receipt.observedProposal && !observed)
        throw new Error(
          "Observed proposal does not match the verified pending approval.",
        );
      if (
        receipt.outcome === "cancelled" &&
        !observed &&
        pending.review.intent !== "cancel-proposal"
      )
        throw new Error(
          "Cancellation receipt requires the reviewed cancellation action.",
        );
      // An identical historical call is not proof of this operation. The guarded
      // host must persist the signed extrinsic hash before broadcast; otherwise hold.
      if (!pending.transactionHash && !observed)
        return { operation: "needs-review" as const, facts };
      // Caller must provide the canonical, exact-call-bound adapter result. The first
      // slice only reconciles chain proxy revocation; membership needs API receipt binding.
      if (pending.review.intent === "leave-membership")
        throw new Error("Use generation-bound API membership reconciliation.");
      if (
        receipt.outcome === "succeeded" &&
        ((pending.review.intent === "revoke-authority" &&
          facts.proxyPresent !== false) ||
          (pending.review.intent === "pay-exit-fees" &&
            facts.fee !== "cleared"))
      )
        return { operation: "needs-review" as const, facts };
      storage.removeItem(key);
      return { operation: receipt.outcome, facts };
    },
  };
}
