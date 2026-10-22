/** Import this entry point ONLY on a server. It contains no built-in credentials. */
import { validatePartnerRequest } from "./request-policy.ts";
import { ADDRESS_PATTERN } from "./server-validation.ts";
import { UUID, TOKEN, record } from "./contracts.ts";
import { boundedJson } from "./transport.ts";
export interface BridgeOptions {
  fetch: typeof fetch;
  apiOrigin: string;
  /** Existing secret store only. Never return this value to the browser. */
  partnerCredential(): Promise<string>;
  /** Check site origin/CSRF, customer authorization, rate limits and partner scope. Fail closed. */
  authorize(
    request: Request,
    route: {
      service: "partner" | "allocation" | "multisig";
      path: string[];
      body: unknown;
    },
  ): Promise<boolean>;
  /** Private-to-public route is never configurable by a browser. */
  partnerPrefix: string;
  allocationPrefix: string;
  /** Optional native multisig authorization route; no private credential is forwarded. */
  multisigPrefix?: string;
}
function allocationRequest(
  method: string,
  path: string[],
  body: unknown,
  headers: Headers,
): void {
  if (
    method === "GET" &&
    path.length === 1 &&
    UUID.test(path[0]) &&
    TOKEN.test(headers.get("x-initial-allocation-read-token") ?? "")
  )
    return;
  if (method !== "POST") throw new Error("Invalid allocation route.");
  const value = record(body);
  if (path.length === 1 && path[0] === "challenge") {
    if (
      Object.keys(value).some(
        (k) =>
          ![
            "walletAddress",
            "signerAddress",
            "strategyId",
            "strategyTable",
            "partnerSessionId",
            "renewCorrelationId",
            "messageFormat",
          ].includes(k),
      ) ||
      !ADDRESS_PATTERN.test(String(value.walletAddress)) ||
      !ADDRESS_PATTERN.test(String(value.signerAddress)) ||
      !UUID.test(String(value.strategyId)) ||
      !UUID.test(String(value.partnerSessionId)) ||
      (value.renewCorrelationId !== undefined &&
        !UUID.test(String(value.renewCorrelationId))) ||
      !["strategies", "custom_strategies"].includes(
        String(value.strategyTable),
      ) ||
      (value.messageFormat !== undefined && value.messageFormat !== "readable")
    )
      throw new Error("Invalid allocation challenge.");
    return;
  }
  if (
    path.length ||
    Object.keys(value).length ||
    !/^0x[0-9a-f]{128,132}$/i.test(headers.get("x-signature") ?? "") ||
    !UUID.test(headers.get("x-correlation-id") ?? "") ||
    !ADDRESS_PATTERN.test(headers.get("x-wallet-address") ?? "") ||
    !ADDRESS_PATTERN.test(headers.get("x-signer-address") ?? "")
  )
    throw new Error("Invalid allocation approval.");
  const message = headers.get("x-message");
  if (!message || message.length > 10_000 || /[\r\n]/.test(message))
    throw new Error("Invalid signed message header.");
}
function multisigRequest(
  method: string,
  path: string[],
  body: unknown,
  headers: Headers,
): void {
  if (
    method !== "POST" ||
    path.length !== 1 ||
    !["challenge", "resolve", "verify"].includes(path[0]) ||
    headers.has("authorization")
  )
    throw new Error("Invalid multisig route.");
  const value = record(body);
  const allowed = [
    "managedWalletAddress",
    "signerAddress",
    "chainId",
    ...(path[0] === "challenge" ? [] : ["challengeId"]),
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !ADDRESS_PATTERN.test(String(value.managedWalletAddress)) ||
    !ADDRESS_PATTERN.test(String(value.signerAddress)) ||
    value.chainId !== "finney" ||
    (path[0] !== "challenge" && !UUID.test(String(value.challengeId)))
  )
    throw new Error("Invalid multisig request.");
}
/** Fetch Request/Response bridge suitable for Next, Workers, or an HTTP server adapter.
 * Only maintained public/session routes and initial-allocation routes are forwarded.
 * It deliberately cannot provision credentials, access the admin API or perform arbitrary requests. */
export function createServerBridge(
  options: BridgeOptions,
): (request: Request) => Promise<Response> {
  const origin = new URL(options.apiOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Configure a trusted HTTPS API origin.");
  const prefixes = [
    options.partnerPrefix,
    options.allocationPrefix,
    ...(options.multisigPrefix ? [options.multisigPrefix] : []),
  ];
  if (
    prefixes.some((prefix, i) =>
      prefixes.some(
        (other, j) =>
          i !== j && (prefix === other || prefix.startsWith(other + "/")),
      ),
    )
  )
    throw new Error("Bridge prefixes overlap.");
  for (const prefix of prefixes) {
    if (
      !/^\/[a-z0-9/_-]+$/.test(prefix) ||
      prefix.endsWith("/") ||
      prefix.includes("..")
    )
      throw new Error("Invalid bridge prefix.");
  }
  return async (request) => {
    try {
      const url = new URL(request.url);
      const service =
        options.multisigPrefix &&
        url.pathname.startsWith(options.multisigPrefix + "/")
          ? "multisig"
          : url.pathname === options.allocationPrefix ||
              url.pathname.startsWith(options.allocationPrefix + "/")
            ? "allocation"
            : url.pathname.startsWith(options.partnerPrefix + "/")
              ? "partner"
              : null;
      if (
        !service ||
        /[\\%]/.test(url.pathname) ||
        (request.method !== "GET" && request.method !== "POST")
      )
        return new Response(null, { status: 404 });
      const prefix =
        service === "partner"
          ? options.partnerPrefix
          : service === "multisig"
            ? options.multisigPrefix!
            : options.allocationPrefix;
      const path = url.pathname
        .slice(prefix.length)
        .replace(/^\//, "")
        .split("/")
        .filter(Boolean);
      const body =
        request.method === "POST"
          ? await boundedJson(new Response(request.body), 30_000)
          : undefined;
      if (service === "partner")
        validatePartnerRequest(
          request.method,
          path,
          url.searchParams,
          body,
          request.headers.get("authorization"),
        );
      else {
        if (url.search) throw new Error("Unexpected allocation query.");
        if (service === "multisig")
          multisigRequest(request.method, path, body, request.headers);
        else allocationRequest(request.method, path, body, request.headers);
      }
      if (!(await options.authorize(request, { service, path, body })))
        return new Response(null, { status: 403 });
      const headers = new Headers({ accept: "application/json" });
      let credential: string | undefined;
      // Public/session calls need no server credential. Allocation uses a scoped
      // partner Bearer key, exactly as required by InitialAllocationServerGuard.
      if (service === "allocation") {
        if (request.headers.has("authorization"))
          throw new Error("Browser server credential rejected.");
        credential = await options.partnerCredential();
        if (!/^tsp_[A-Za-z0-9_-]{16,250}$/.test(credential))
          throw new Error("Invalid server credential.");
        headers.set("authorization", `Bearer ${credential}`);
      } else {
        const session = request.headers.get("authorization");
        if (session) headers.set("authorization", session);
      }
      for (const name of [
        "x-signature",
        "x-message",
        "x-wallet-address",
        "x-signer-address",
        "x-correlation-id",
        "x-initial-allocation-read-token",
      ]) {
        const value = request.headers.get(name);
        if (service === "allocation" && value) headers.set(name, value);
      }
      if (body !== undefined) headers.set("content-type", "application/json");
      const upstream = `${origin.origin}/api/v1/${service === "partner" ? "partners" : service === "multisig" ? "multisig/auth" : "membership/initial-allocation"}${path.length ? "/" + path.join("/") : ""}${url.search}`;
      const response = await options.fetch(upstream, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const result = await boundedJson(response);
      if (credential && JSON.stringify(result).includes(credential))
        throw new Error("Credential in upstream response.");
      // Only JSON/status passes through. No upstream cookies, credentials or CORS headers.
      return Response.json(result, {
        status: response.status,
        headers: {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    } catch {
      return Response.json(
        { code: "BRIDGE_REQUEST_FAILED" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
  };
}

export { createNativeExitBridge, validateNativeExitRequest } from "./exit-bridge.ts";
