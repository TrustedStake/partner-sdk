import { isExitBeforeBroadcast } from "./exit-submission.ts";
import {
  createExitJournal,
  reviewNativeExit,
  assertExitReview,
  type ExitScope,
  type ExitFacts,
  type ExitIntent,
  type ExitPending,
  type CanonicalExitReceipt,
  type ExitApproval,
} from "./exit.ts";
import {
  createNativeExitApi,
  type ExitSelection,
  type ExitContext,
  type ExitCheckout,
} from "./exit-api.ts";
import type { Storage, Wallet } from "./types.ts";
import type { MutationCoordinator } from "./ownership.ts";
import type {
  ExitChainState,
  ExitConversionSelection,
  ExitConversionQuote,
} from "./exit-types.ts";
import type { PendingMultisigOp } from "./polkadot/types.ts";

export interface NativeExitPrepared {
  transaction: unknown;
  multisig?: PendingMultisigOp;
  multisigExecution?: boolean;
  callHash: string;
  callDataHex: string;
  assertCurrent(): Promise<void>;
}
export interface NativeExitChain {
  read(scope: ExitScope): Promise<ExitChainState>;
  prepareFeePayment(
    scope: ExitScope,
    quote: ExitCheckout,
    assertCurrent: () => Promise<void>,
  ): Promise<NativeExitPrepared>;
  prepareRevocation(
    scope: ExitScope,
    assertCurrent: () => Promise<void>,
  ): Promise<NativeExitPrepared>;
  prepareConversion(
    scope: ExitScope,
    positions: ExitConversionSelection[],
    slippageBps: number,
    allowPartial: boolean,
    assertCurrent: () => Promise<void>,
  ): Promise<NativeExitPrepared & { quote: ExitConversionQuote }>;
  prepareCancellation?(
    scope: ExitScope,
    pending: ExitPending,
    assertCurrentFlow: () => void,
  ): Promise<NativeExitPrepared>;
  prepareFrozenConversion?(
    scope: ExitScope,
    callDataHex: string,
    assertCurrent: () => Promise<void>,
  ): Promise<NativeExitPrepared & { quote: ExitConversionQuote }>;
  wrapMultisig?(
    scope: ExitScope,
    prepared: NativeExitPrepared,
    config: { signatories: string[]; threshold: number },
    assertCurrentFlow: () => void,
    existing?: PendingMultisigOp,
  ): Promise<NativeExitPrepared>;
  verifyApproval?(
    pending: ExitPending,
    transactionHash: string,
    blockHash: string,
  ): Promise<ExitApproval | null>;
  receipt(
    pending: ExitPending,
    transactionHash: string,
    blockHash: string,
    multisig?: PendingMultisigOp,
  ): Promise<CanonicalExitReceipt>;
}
export interface NativeExitSnapshot {
  context: ExitContext;
  facts: ExitFacts;
  pending: ExitPending | null;
  /** These outcomes are deliberately separate; no automatic external transfer. */
  membershipEnded: boolean;
  authorityRemoved: boolean;
  remainingPositions: ExitChainState["positions"];
  nextAction:
    | "review-fees"
    | "end-membership"
    | "wait-for-work"
    | "review-legacy-membership"
    | "revoke-authority"
    | "choose-conversion"
    | "reconcile-transaction"
    | "await-signers"
    | "done";
}
export interface NativeExitReview {
  intent: ExitIntent;
  conversion?: ExitConversionQuote;
  fees?: ExitCheckout;
  multisig?: {
    approved: number;
    required: number;
    action: "approve" | "execute" | "cancel";
  };
}
/** Host wallet review/signing boundary. onSigned MUST persist the signed hash before broadcast. */
export type ExitSubmitter = (
  transaction: unknown,
  assertCurrent: () => Promise<void>,
  onSigned: (hash: string) => void,
) => Promise<{
  transactionHash: string;
  blockHash: string;
  multisig?: PendingMultisigOp;
}>;

export function createNativeExitController(options: {
  api: ReturnType<typeof createNativeExitApi>;
  chain: NativeExitChain;
  wallet: Wallet;
  selection: ExitSelection;
  storage: Storage;
  coordinator: MutationCoordinator;
  multisig?: { signatories: string[]; threshold: number };
  now(): number;
  uuid(): string;
  sha256(value: string): Promise<string>;
}) {
  const { api, chain, wallet, storage, coordinator, now } = options;
  const multisigConfig = options.multisig
    ? structuredClone(options.multisig)
    : undefined;
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  let selection = structuredClone(options.selection),
    checkout: ExitCheckout | undefined,
    feeClearedUntil = 0,
    last: NativeExitSnapshot | undefined,
    busy = false;
  const reviews = new WeakMap<
      NativeExitReview,
      {
        prepared: NativeExitPrepared;
        review: ReturnType<typeof reviewNativeExit>;
        scope: ExitScope;
        fees?: ExitCheckout;
        continuation?: boolean;
      }
    >(),
    consumed = new WeakSet<NativeExitReview>();
  const scopeFor = (context: ExitContext): ExitScope => ({
    wallet: context.walletAddress,
    signer: wallet.signerAddress,
    genesisHash: context.genesisHash,
    strategyId: context.selection.strategyId,
    strategyTable: context.selection.strategyTable,
    generation: context.selection.expectedGeneration,
    delegate: context.selection.proxy,
  });
  const journalFor = (scope: ExitScope) => {
    const initial = createExitJournal(
        storage,
        options.uuid(),
        scope,
        coordinator,
      ),
      pending = initial.pending();
    return pending
      ? createExitJournal(storage, pending.operationId, scope, coordinator)
      : initial;
  };
  async function refresh(): Promise<NativeExitSnapshot> {
    wallet.assertCurrentFlow();
    const context = await api.context(selection),
      scope = scopeFor(context),
      state = await chain.read(scope);
    wallet.assertCurrentFlow();
    selection = structuredClone(context.selection);
    const facts: ExitFacts = {
      ...state,
      scope,
      membership: context.membership,
      allocation:
        context.allocation.state === "quiescent"
          ? "quiescent"
          : context.allocation.state === "pending"
            ? "running"
            : "unknown",
      fee:
        now() < feeClearedUntil
          ? "cleared"
          : checkout?.required
            ? "payment-required"
            : "unknown",
      otherProxyDependencies: context.otherProxyDependencies.length,
      otherActiveMemberships: context.otherActiveMemberships,
    };
    const journal = journalFor(scope);
    if (
      journal.pending()?.review.intent === "leave-membership" &&
      facts.membership === "ended"
    )
      journal.reconcileMembership(facts, now());
    const pending = journal.pending(),
      remainingPositions = state.positions.filter(
        (p) => BigInt(p.amountRao) > 0n,
      );
    const nextAction: NativeExitSnapshot["nextAction"] = pending
      ? pending.review.intent === "leave-membership" && !pending.transactionHash
        ? facts.fee === "cleared"
          ? "end-membership"
          : "review-fees"
        : pending.state === "awaiting-signers"
          ? "await-signers"
          : "reconcile-transaction"
      : facts.membership === "active"
        ? !context.canStopMembership
          ? "review-legacy-membership"
          : facts.fee !== "cleared"
            ? "review-fees"
            : "end-membership"
        : facts.allocation !== "quiescent"
          ? "wait-for-work"
          : facts.otherProxyDependencies !== 0
            ? "review-legacy-membership"
            : facts.proxyPresent
              ? "revoke-authority"
              : facts.otherActiveMemberships !== 0
                ? "review-legacy-membership"
                : facts.fee !== "cleared"
                  ? "review-fees"
                  : remainingPositions.length
                    ? "choose-conversion"
                    : "done";
    return (last = {
      context,
      facts,
      pending,
      membershipEnded: facts.membership === "ended",
      authorityRemoved: !state.proxyPresent,
      remainingPositions,
      nextAction,
    });
  }
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (busy) throw new Error("An exit action is already open.");
    busy = true;
    try {
      return await action();
    } finally {
      busy = false;
    }
  }
  async function reviewFees() {
    return exclusive(async () => {
      const snapshot = await refresh();
      if (
        snapshot.pending &&
        snapshot.pending.review.intent !== "leave-membership" &&
        (snapshot.pending.state !== "awaiting-signers" ||
          snapshot.pending.review.intent === "pay-exit-fees")
      )
        throw new Error(
          "Reconcile the pending transaction before another fee review.",
        );
      feeClearedUntil = 0;
      checkout = undefined;
      checkout = await api.checkout(snapshot.facts.scope);
      if (checkout.reviewItems.length)
        throw new Error("Fee invoices need review before continuing.");
      feeClearedUntil = !checkout.required ? now() + 60000 : 0;
      return { checkout: structuredClone(checkout), snapshot: await refresh() };
    });
  }
  async function endMembership() {
    return exclusive(async () => {
      const snapshot = await refresh(),
        scope = snapshot.facts.scope;
      const review = reviewNativeExit(
          "leave-membership",
          snapshot.facts,
          scope,
          now(),
        ),
        journal = journalFor(scope);
      const callHash = `0x${await options.sha256(JSON.stringify([scope, "leave-membership"]))}`;
      const previous = journal.pending();
      if (previous) {
        if (
          previous.review.intent !== "leave-membership" ||
          previous.transactionHash ||
          previous.callHash !== callHash
        )
          throw new Error(
            "Reconcile the earlier transaction before ending membership.",
          );
      } else await journal.begin(review, snapshot.facts, now(), callHash);
      // The signed API action is generation-idempotent. A lost response is resolved by
      // subsequent owner reads; neither method executes chain liquidation.
      try {
        await api.stop(scope);
      } catch (error) {
        if (isExitBeforeBroadcast(error)) journal.restoreUnsent();
        throw error;
      }
      return refresh();
    });
  }
  async function authority(
    scope: ExitScope,
    intent: Exclude<ExitIntent, "leave-membership">,
  ) {
    wallet.assertCurrentFlow();
    const snapshot = await refresh();
    if (
      snapshot.facts.scope.generation !== scope.generation ||
      snapshot.facts.scope.wallet !== scope.wallet ||
      snapshot.facts.scope.signer !== scope.signer
    )
      throw new Error("Exit account or membership generation changed.");
    reviewNativeExit(intent, snapshot.facts, scope, now());
  }
  async function prepare(
    intent: Exclude<ExitIntent, "leave-membership">,
    conversion?: {
      positions: ExitConversionSelection[];
      slippageBps: number;
      allowPartial: boolean;
    },
  ): Promise<NativeExitReview> {
    return exclusive(async () => {
      const snapshot = await refresh();
      if (intent === "cancel-proposal")
        throw new Error("Review cancellation with prepareCancellation.");
      if (snapshot.pending)
        throw new Error(
          "Reconcile the earlier transaction before preparing another.",
        );
      if (
        !api.sameWallet(wallet.signerAddress, wallet.managedWalletAddress) &&
        !multisigConfig
      )
        throw new Error(
          "Configure the managed wallet multisig before financial actions.",
        );
      const scope = snapshot.facts.scope,
        review = reviewNativeExit(intent, snapshot.facts, scope, now());
      const check = () => authority(scope, intent);
      let prepared: NativeExitPrepared, quote: ExitConversionQuote | undefined;
      if (intent === "pay-exit-fees") {
        if (!checkout) throw new Error("Review exit fees first.");
        prepared = await chain.prepareFeePayment(scope, checkout, check);
      } else if (intent === "revoke-authority")
        prepared = await chain.prepareRevocation(scope, check);
      else {
        if (!conversion)
          throw new Error(
            "Choose holdings, protected limits and partial-fill policy.",
          );
        const p = await chain.prepareConversion(
          scope,
          conversion.positions,
          conversion.slippageBps,
          conversion.allowPartial,
          check,
        );
        prepared = p;
        quote = p.quote;
      }
      if (multisigConfig) {
        if (!chain.wrapMultisig)
          throw new Error("The chain adapter does not support multisig exits.");
        prepared = await chain.wrapMultisig(
          scope,
          prepared,
          multisigConfig,
          () => wallet.assertCurrentFlow(),
        );
      }
      const handle: NativeExitReview = freeze({
        intent,
        ...(prepared.multisig
          ? {
              multisig: {
                approved: prepared.multisig.approvals?.length ?? 0,
                required: prepared.multisig.threshold,
                action: prepared.multisigExecution
                  ? ("execute" as const)
                  : ("approve" as const),
              },
            }
          : {}),
        ...(quote ? { conversion: structuredClone(quote) } : {}),
        ...(intent === "pay-exit-fees"
          ? { fees: structuredClone(checkout) }
          : {}),
      });
      reviews.set(handle, {
        prepared,
        review,
        scope,
        ...(intent === "pay-exit-fees"
          ? { fees: structuredClone(checkout) }
          : {}),
      });
      return handle;
    });
  }
  async function prepareContinuation(): Promise<NativeExitReview> {
    return exclusive(async () => {
      let snapshot = await refresh();
      const pending = snapshot.pending,
        scope = snapshot.facts.scope;
      if (
        !pending ||
        pending.state !== "awaiting-signers" ||
        !pending.details?.multisig ||
        !chain.wrapMultisig
      )
        throw new Error(
          "No verified multisig approval is awaiting continuation.",
        );
      const intent = pending.review.intent;
      if (intent === "leave-membership")
        throw new Error("Membership messages are not chain proposals.");
      if (intent === "pay-exit-fees") {
        checkout = structuredClone(pending.details.feeCheckout);
        if (!checkout)
          throw new Error("The saved fee checkout is unavailable.");
        snapshot = await refresh();
      }
      const review = reviewNativeExit(intent, snapshot.facts, scope, now()),
        check = () => authority(scope, intent);
      let prepared: NativeExitPrepared, quote: ExitConversionQuote | undefined;
      if (intent === "pay-exit-fees")
        prepared = await chain.prepareFeePayment(scope, checkout!, check);
      else if (intent === "revoke-authority")
        prepared = await chain.prepareRevocation(scope, check);
      else {
        if (!chain.prepareFrozenConversion)
          throw new Error("Fixed protected-call review is unavailable.");
        const p = await chain.prepareFrozenConversion(
          scope,
          pending.details.multisig.callDataHex,
          check,
        );
        prepared = p;
        quote = p.quote;
      }
      if (prepared.callHash !== pending.callHash)
        throw new Error(
          "The existing proposal changed. Do not replace or execute it.",
        );
      prepared = await chain.wrapMultisig(
        scope,
        prepared,
        {
          signatories: pending.details.multisig.signatories,
          threshold: pending.details.multisig.threshold,
        },
        () => wallet.assertCurrentFlow(),
        pending.details.multisig,
      );
      const handle: NativeExitReview = freeze({
        intent,
        ...(quote ? { conversion: structuredClone(quote) } : {}),
        ...(checkout && intent === "pay-exit-fees"
          ? { fees: structuredClone(checkout) }
          : {}),
        multisig: {
          approved: prepared.multisig?.approvals?.length ?? 0,
          required: pending.details.multisig.threshold,
          action: prepared.multisigExecution
            ? ("execute" as const)
            : ("approve" as const),
        },
      });
      reviews.set(handle, {
        prepared,
        review,
        scope,
        continuation: true,
        ...(intent === "pay-exit-fees"
          ? { fees: structuredClone(checkout) }
          : {}),
      });
      return handle;
    });
  }
  async function prepareCancellation(): Promise<NativeExitReview> {
    return exclusive(async () => {
      const snapshot = await refresh(),
        pending = snapshot.pending,
        scope = snapshot.facts.scope;
      if (
        !pending ||
        pending.state !== "awaiting-signers" ||
        !chain.prepareCancellation
      )
        throw new Error(
          "Reconcile any unknown submission before cancellation.",
        );
      const review = reviewNativeExit(
        "cancel-proposal",
        snapshot.facts,
        scope,
        now(),
      );
      const prepared = await chain.prepareCancellation(scope, pending, () =>
        wallet.assertCurrentFlow(),
      );
      const handle: NativeExitReview = freeze({
        intent: "cancel-proposal",
        multisig: {
          approved: pending.details?.multisig?.approvals?.length ?? 0,
          required: pending.details?.multisig?.threshold ?? 0,
          action: "cancel" as const,
        },
      });
      reviews.set(handle, { prepared, review, scope, continuation: true });
      return handle;
    });
  }
  async function reconcile(receipt: {
    transactionHash: string;
    blockHash: string;
    multisig?: PendingMultisigOp;
  }) {
    const snapshot = await refresh(),
      journal = journalFor(snapshot.facts.scope),
      pending = journal.pending();
    if (!pending) return snapshot;
    const verified = await chain.receipt(
      pending,
      receipt.transactionHash,
      receipt.blockHash,
      pending.details?.multisig
        ? {
            ...pending.details.multisig,
            extrinsicHash: receipt.transactionHash,
            blockHash: receipt.blockHash,
          }
        : undefined,
    );
    if (verified.outcome === "unknown") {
      if (pending.details?.multisig && chain.verifyApproval) {
        const approval = await chain.verifyApproval(
          pending,
          receipt.transactionHash,
          receipt.blockHash,
        );
        if (approval) {
          journal.recordApproval(approval);
          return refresh();
        }
      }
      return snapshot;
    }
    if (
      verified.outcome === "succeeded" &&
      pending.review.intent === "pay-exit-fees"
    ) {
      if (!pending.details?.feeBundleId || !pending.details.feeCheckout)
        throw new Error("Fee bundle receipt needs review.");
      await api.recordFeePayment(
        pending.details.feeBundleId,
        verified,
        pending.details.feeCheckout,
      );
      feeClearedUntil = now() + 60000;
      checkout = undefined;
    }
    const current = await refresh();
    journal.reconcile(verified, current.facts, now());
    return refresh();
  }
  async function submit(handle: NativeExitReview, submitter: ExitSubmitter) {
    return exclusive(async () => {
      const action = reviews.get(handle);
      if (!action || consumed.has(handle))
        throw new Error("This exit review is missing or was already used.");
      consumed.add(handle);
      const fresh = await refresh();
      assertExitReview(action.review, fresh.facts, now());
      const journal = journalFor(action.scope);
      if (action.continuation)
        await journal.continueReview(
          action.review,
          fresh.facts,
          now(),
          action.prepared.callHash,
        );
      else
        await journal.begin(
          action.review,
          fresh.facts,
          now(),
          action.prepared.callHash,
          {
            ...(action.fees?.bundleId
              ? { feeBundleId: action.fees.bundleId, feeCheckout: action.fees }
              : {}),
            ...(action.prepared.multisig
              ? { multisig: action.prepared.multisig }
              : {}),
          },
        );
      const signingBoundary = async () => {
        await action.prepared.assertCurrent();
        const current = await refresh();
        wallet.assertCurrentFlow();
        assertExitReview(action.review, current.facts, now());
        // Recheck exact inner/outer bytes after the final asynchronous context refresh.
        await action.prepared.assertCurrent();
      };
      let handedOff = false;
      let receipt: Awaited<ReturnType<ExitSubmitter>>;
      try {
        await signingBoundary();
        handedOff = true;
        receipt = await submitter(
          action.prepared.transaction,
          signingBoundary,
          (hash) => journal.submitted(hash),
        );
      } catch (error) {
        if (!handedOff || isExitBeforeBroadcast(error)) journal.restoreUnsent();
        throw error;
      }
      // Never trust a wallet's return value as execution proof or silently backfill
      // an unjournaled submission hash after a broadcast.
      if (journal.pending()?.transactionHash !== receipt.transactionHash)
        throw new Error(
          "Submission identity is unknown. Reconcile before continuing.",
        );
      return reconcile(receipt);
    });
  }
  return {
    authenticate: api.authenticate,
    refresh,
    reviewFees,
    endMembership,
    prepare,
    prepareContinuation,
    prepareCancellation,
    submit,
    reconcile,
    lastSnapshot: () => (last ? structuredClone(last) : undefined),
  };
}
