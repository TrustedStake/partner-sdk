import type { ApiPromise } from "@polkadot/api";
import type { EventRecord } from "@polkadot/types/interfaces";
import { blake2AsHex } from "@polkadot/util-crypto";
import { createMultisigProposal, prepareMultisigAction } from "./actions.ts";
import { deriveMultisigAddress, getMultisigStorageEntry } from "./multisig.ts";
import { sameTimepoint } from "./multisig-recovery.ts";
import { sameWallet } from "./wallet-identity.ts";
import { decodeBatchEvents } from "./receipt-events.ts";
import type { ExitScope, ExitPending, ExitApproval } from "../exit.ts";
import type { PreparedNativeExit } from "./native-exit.ts";
import type { PendingMultisigOp } from "./types.ts";
export async function wrapMultisigExit(
  api: ApiPromise,
  scope: ExitScope,
  prepared: PreparedNativeExit,
  config: { signatories: string[]; threshold: number },
  assertCurrentFlow: () => void,
  existing?: PendingMultisigOp,
) {
  const proposal = existing
    ? structuredClone(existing)
    : await createMultisigProposal(
        api,
        prepared.transaction,
        config.signatories,
        config.threshold,
        scope.signer,
        assertCurrentFlow,
      );
  if (
    !sameWallet(proposal.managedAccount, scope.wallet) ||
    proposal.chainId !== scope.genesisHash ||
    proposal.callHashHex !== prepared.callHash ||
    blake2AsHex(proposal.callDataHex, 256) !== prepared.callHash
  )
    throw new Error(
      "Multisig exit proposal does not match this reviewed call.",
    );
  const multi = await prepareMultisigAction(
    api,
    proposal,
    scope.signer,
    "approve",
    assertCurrentFlow,
  );
  const outerHex = multi.transaction.method.toHex();
  const assertOuter = () => {
    if (multi.transaction.method.toHex() !== outerHex)
      throw new Error("Reviewed multisig transaction changed.");
  };
  const assertCurrent = async () => {
    assertOuter();
    assertCurrentFlow();
    await prepared.assertCurrent();
    await multi.assertCurrent();
    await prepared.assertCurrent();
    assertOuter();
  };
  const stored = await getMultisigStorageEntry(
    api,
    scope.wallet,
    prepared.callHash,
  );
  return {
    ...prepared,
    transaction: multi.transaction,
    assertCurrent,
    multisig: {
      ...multi.operation,
      ...(stored ?? {}),
      currentSigner: scope.signer,
    },
    multisigExecution: String(multi.transaction.method.method) === "asMulti",
  };
}
/** Approval is not execution. Verify its exact canonical outer receipt, event and finalized live proposal. */
export async function verifyExitApproval(
  api: ApiPromise,
  pending: ExitPending,
  transactionHash: string,
  blockHash: string,
): Promise<ExitApproval | null> {
  const op = pending.details?.multisig,
    scope = pending.review.scope;
  if (
    !op ||
    !pending.transactionHash ||
    pending.transactionHash !== transactionHash ||
    op.callHashHex !== pending.callHash ||
    blake2AsHex(op.callDataHex, 256) !== pending.callHash ||
    !sameWallet(op.managedAccount, scope.wallet) ||
    !sameWallet(op.multisigAddress, scope.wallet) ||
    op.chainId !== scope.genesisHash ||
    api.genesisHash.toHex() !== scope.genesisHash
  )
    return null;
  const derived = await deriveMultisigAddress(op.signatories, op.threshold, 42);
  if (!sameWallet(derived.multisigAddress, scope.wallet))
    throw new Error("Invalid multisig exit account.");
  const tip = await api.rpc.chain.getFinalizedHead(),
    [head, header] = await Promise.all([
      api.rpc.chain.getHeader(tip),
      api.rpc.chain.getHeader(blockHash),
    ]);
  const height = Number(header.number.toString());
  if (
    header.number.toBigInt() > head.number.toBigInt() ||
    height <= pending.review.blockNumber ||
    (await api.rpc.chain.getBlockHash(height)).toHex() !== blockHash
  )
    return null;
  const block = await api.rpc.chain.getBlock(blockHash),
    index = block.block.extrinsics.findIndex(
      (tx) => tx.hash.toHex() === transactionHash,
    );
  if (index < 0) return null;
  const tx = block.block.extrinsics[index];
  if (
    !tx.isSigned ||
    !sameWallet(tx.signer.toString(), scope.signer) ||
    String(tx.method.section) !== "multisig" ||
    String(tx.method.method) !== "approveAsMulti" ||
    String(tx.method.args[3]) !== pending.callHash
  )
    return null;
  const raw = await api.query.system.events.at(blockHash),
    events = (raw as unknown as EventRecord[]).filter(
      (e) =>
        e.phase.isApplyExtrinsic &&
        e.phase.asApplyExtrinsic.toNumber() === index,
    );
  if (
    !decodeBatchEvents(events).success ||
    events.some(
      (e) =>
        String(e.event.section) === "multisig" &&
        String(e.event.method) === "MultisigExecuted",
    )
  )
    return null;
  const entry = await getMultisigStorageEntry(
    api,
    scope.wallet,
    pending.callHash,
  );
  if (!entry || !entry.approvals.some((a) => sameWallet(a, scope.signer)))
    return null;
  let matched = false;
  for (const { event } of events) {
    if (String(event.section) !== "multisig") continue;
    if (
      String(event.method) === "NewMultisig" &&
      !op.timepoint &&
      sameWallet(event.data[0].toString(), scope.signer) &&
      sameWallet(event.data[1].toString(), scope.wallet) &&
      event.data[2].toString() === pending.callHash &&
      entry.timepoint.height === height &&
      entry.timepoint.index === index
    )
      matched = true;
    if (
      String(event.method) === "MultisigApproval" &&
      op.timepoint &&
      sameWallet(event.data[0].toString(), scope.signer) &&
      sameWallet(event.data[2].toString(), scope.wallet) &&
      event.data[3].toString() === pending.callHash &&
      sameTimepoint(
        event.data[1].toJSON() as { height: number; index: number },
        op.timepoint,
      ) &&
      sameTimepoint(entry.timepoint, op.timepoint)
    )
      matched = true;
  }
  if (!matched) return null;
  return {
    operationId: pending.operationId,
    scope: structuredClone(scope),
    callHash: pending.callHash,
    transactionHash,
    blockHash,
    blockNumber: height,
    extrinsicIndex: index,
    approvalVerified: true,
    operation: {
      ...structuredClone(op),
      ...entry,
      status: "pending_approvals",
      extrinsicHash: transactionHash,
      blockHash,
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function prepareExitCancellation(
  api: ApiPromise,
  scope: ExitScope,
  pending: ExitPending,
  assertCurrentFlow: () => void,
) {
  const op = pending.details?.multisig;
  if (
    !op?.timepoint ||
    op.chainId !== scope.genesisHash ||
    !sameWallet(op.managedAccount, scope.wallet) ||
    op.callHashHex !== pending.callHash
  )
    throw new Error("No verified exit proposal is available to cancel.");
  const action = await prepareMultisigAction(
    api,
    op,
    scope.signer,
    "cancel",
    assertCurrentFlow,
  );
  const outerHex = action.transaction.method.toHex();
  const assertCurrent = async () => {
    if (action.transaction.method.toHex() !== outerHex)
      throw new Error("Reviewed multisig cancellation changed.");
    await action.assertCurrent();
    if (action.transaction.method.toHex() !== outerHex)
      throw new Error("Reviewed multisig cancellation changed.");
  };
  return {
    transaction: action.transaction,
    assertCurrent,
    callDataHex: op.callDataHex,
    callHash: op.callHashHex,
    multisig: action.operation,
  };
}
