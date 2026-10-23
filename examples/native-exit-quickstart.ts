import {
  createNativeExitApi,
  createNativeExitController,
  createWebLocksCoordinator,
  type ExitSelection,
  type Wallet,
} from "@trustedstake/partner-sdk";
import {
  createPolkadotNativeExitAdapter,
  createExitWalletSubmitter,
} from "@trustedstake/partner-sdk/polkadot";
import type { ApiPromise } from "@polkadot/api";
import type { Signer } from "@polkadot/api/types";

/** Candidate-only: deploy and qualify the matching owner-exit API before enabling this UI. */
export function nativeExit(options: {
  api: ApiPromise;
  partnerId: string;
  selection: ExitSelection;
  wallet: Wallet;
  signer: Signer;
  sameWallet(a: string, b: string): boolean;
  sha256(value: string): Promise<string>;
  multisig?: { signatories: string[]; threshold: number };
}) {
  const wallet = options.wallet;
  const api = createNativeExitApi({
    partnerId: options.partnerId,
    wallet,
    request: async (path, init) => {
      // If the host uses cookie sessions, add its same-origin authentication/CSRF
      // explicitly here. The required server authorize callback must verify it.
      const response = await fetch(`/exit/${path}`, {
        ...init,
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok)
        throw new Error(`Exit request unavailable (${response.status}).`);
      return response.json();
    },
    sameWallet: options.sameWallet,
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    sha256: options.sha256,
  });
  const controller = createNativeExitController({
    api,
    chain: createPolkadotNativeExitAdapter(options.api),
    wallet,
    selection: options.selection,
    storage: localStorage,
    coordinator: createWebLocksCoordinator(
      navigator.locks,
      `exit:${wallet.genesisHash}:${wallet.managedWalletAddress}`,
    ),
    multisig: options.multisig,
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    sha256: options.sha256,
  });
  const submitter = createExitWalletSubmitter(
    wallet.signerAddress,
    options.signer,
    () => wallet.assertCurrentFlow(),
  );
  return {
    controller,
    // Each mutation belongs to an explicit user action. Refresh never opens a wallet.
    authorizeRead: () => controller.authenticate(),
    refresh: () => controller.refresh(),
    reviewFees: () => controller.reviewFees(),
    endMembership: () => controller.endMembership(),
    reviewAuthorityRemoval: () => controller.prepare("revoke-authority"),
    reviewConversion: (positions: Parameters<typeof controller.prepare>[1]) =>
      controller.prepare("convert-alpha", positions),
    continueMultisig: () => controller.prepareContinuation(),
    cancelOwnProposal: () => controller.prepareCancellation(),
    // Display exact purpose, recipients/amounts, limits, partial policy, excluded
    // positions and signer progress before enabling this single wallet action.
    submit: (review: Awaited<ReturnType<typeof controller.prepare>>) =>
      controller.submit(review, submitter),
    reconcile: (receipt: Parameters<typeof controller.reconcile>[0]) =>
      controller.reconcile(receipt),
  };
}
