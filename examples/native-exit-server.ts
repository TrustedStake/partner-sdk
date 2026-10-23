// Server-only example. Do not import this file into your browser app.
import { createNativeExitBridge } from "@trustedstake/partner-sdk/server";
export function exitBridge(
  apiOrigin: string,
  authorize: (request: Request) => Promise<boolean>,
) {
  return createNativeExitBridge({
    apiOrigin,
    prefix: "/exit",
    fetch,
    authorize,
  });
}
