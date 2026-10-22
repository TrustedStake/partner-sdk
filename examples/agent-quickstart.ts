import {
  createPartnerClient,
  type Dependencies,
  type Wallet,
  type ChainAdapter,
} from "@trustedstake/partner-sdk";

/** Wire these operations to separate, explicit user actions in your own UI. */
export async function openPartnerFlow(options: {
  dependencies: Dependencies;
  wallet: Wallet;
  chain: ChainAdapter;
  sessionId: string;
  launchToken: string;
}) {
  const client = createPartnerClient(options.dependencies);
  const access = await client.open(options.sessionId, options.launchToken);
  const session = client.session(access, options.wallet, options.chain);
  return {
    // Render the current fee disclosure returned here before enabling Join.
    review: () => session.review(),
    join: async (reviewed: Awaited<ReturnType<typeof session.review>>) => {
      const anchor = await session.ensurePermissions(reviewed);
      return session.register(reviewed, anchor);
    },
    // A returning member explicitly proves wallet identity before reading state.
    verifyExistingMember: () => session.verifyWallet(),
    completeSetup: (reviewed: Awaited<ReturnType<typeof session.review>>) =>
      session.completeSetup(reviewed),
    // Never call this automatically after join; connect it to a separate approval.
    requestInitialRebalance: () => session.allocate(true),
    // Show renewal consent only for an expired, never-started receipt.
    renewExpiredInitialRebalance: () => session.renewAllocation(true),
    readInitialRebalance: () => session.allocationStatus(),
    reconcile: () => session.reconcile(),
    hostedContinuation: () => session.continuation(),
  };
}
