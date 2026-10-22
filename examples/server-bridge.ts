import { createServerBridge } from "@trustedstake/partner-sdk/server";
/** Adapt this Fetch handler to your existing server. No listener or credential creation. */
export function partnerBridge(config: {
  apiOrigin: string;
  siteOrigin: string;
  getExistingPartnerKey: () => Promise<string>;
  authorizeCustomer: Parameters<typeof createServerBridge>[0]["authorize"];
}) {
  return createServerBridge({
    fetch,
    apiOrigin: config.apiOrigin,
    partnerPrefix: "/bridge",
    allocationPrefix: "/rebalance",
    multisigPrefix: "/multisig",
    partnerCredential: config.getExistingPartnerKey,
    authorize: async (request, route) => {
      if (new URL(request.url).origin !== config.siteOrigin) return false;
      if (
        request.method === "POST" &&
        (request.headers.get("origin") !== config.siteOrigin ||
          request.headers.get("content-type")?.split(";", 1)[0] !==
            "application/json")
      )
        return false;
      return config.authorizeCustomer(request, route);
    },
  });
}
