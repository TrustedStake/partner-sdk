import type { ApiPromise } from "@polkadot/api";
import {
  createPolkadotChainAdapter,
  createAuthorizationTransport,
  createAuthorizationDeposit,
  verifyAuthorizationDeposit,
  prepareAuthorizationCancellation,
  importAuthorizationProof,
  exportAuthorizationProof,
  importMultisigProposal,
  exportMultisigProposal,
  prepareMultisigAction,
  submitPreparedMultisigAction,
  getMultisigStorageEntry,
  inferPendingOpStatus,
  type PendingMultisigOp,
  type PreparedMultisigAction,
} from "@trustedstake/partner-sdk/polkadot";

/** The host retains UI, signer, tab ownership and durable storage; no hosted continuation is required. */
export function multisigFlow(options: {
  api: ApiPromise;
  signerAddress: string;
  assertCurrentFlow(): void;
  // Must synchronously persist the public operation BEFORE returning; throw on failure.
  save(operation: PendingMultisigOp): void;
  // Use your guarded signer: await assertCurrent immediately before wallet signing.
  // Confirm finalized dispatch success and return canonical receipt hashes; never retry automatically.
  submit: Parameters<typeof submitPreparedMultisigAction>[1];
  fetch: typeof fetch;
}) {
  const request = createAuthorizationTransport(options.fetch, "/multisig");
  const inspect = async (op: PendingMultisigOp) => {
    options.assertCurrentFlow();
    const entry = await getMultisigStorageEntry(
      options.api,
      op.multisigAddress,
      op.callHashHex,
    );
    const outcome = await inferPendingOpStatus(options.api, op, entry);
    options.assertCurrentFlow();
    const updated = {
      ...op,
      ...outcome,
      ...(entry
        ? { depositor: entry.depositor, approvals: entry.approvals }
        : {}),
    };
    options.save(updated);
    return updated;
  };
  return {
    importProposal: (file: string) =>
      importMultisigProposal(options.api, file, options.signerAddress),
    exportProposal: exportMultisigProposal,
    prepareProposalAction: (
      op: PendingMultisigOp,
      action: "approve" | "cancel",
    ) =>
      prepareMultisigAction(
        options.api,
        op,
        options.signerAddress,
        action,
        options.assertCurrentFlow,
      ),
    // Render the exact call and action for user review BEFORE invoking this function.
    submitReviewed: async (prepared: PreparedMultisigAction) =>
      inspect(
        await submitPreparedMultisigAction(
          prepared,
          options.submit,
          options.save,
        ),
      ),
    inspect,
    // Pass this adapter into client.session(access, wallet, adapter).
    permissions: createPolkadotChainAdapter(options.api, options.submit),
    prepareNewAuthorization: (signatories: string[], threshold: number) =>
      createAuthorizationDeposit(
        options.api,
        signatories,
        threshold,
        options.signerAddress,
        request,
        options.assertCurrentFlow,
      ),
    // After submission or reload, verify the existing deposit; do not create another challenge/deposit.
    resumeAuthorization: (op: PendingMultisigOp) =>
      verifyAuthorizationDeposit(
        options.api,
        op,
        options.signerAddress,
        request,
        options.assertCurrentFlow,
        options.save,
      ),
    exportAuthorization: exportAuthorizationProof,
    importAuthorization: (file: string) =>
      importAuthorizationProof(
        options.api,
        file,
        options.signerAddress,
        request,
      ),
    prepareReclaim: (op: PendingMultisigOp) =>
      prepareAuthorizationCancellation(
        options.api,
        op,
        options.signerAddress,
        request,
        options.assertCurrentFlow,
      ),
  };
}
