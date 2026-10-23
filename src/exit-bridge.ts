import { UUID, HASH, record } from "./contracts.ts";
import { boundedJson } from "./transport.ts";
const address = /^[1-9A-HJ-NP-Za-km-z]{47,50}$/;
const signature = /^0x[0-9a-f]{128,132}$/i;
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((k) => keys.includes(k));
/** Exit-only route policy. Never forwards partner credentials, cookies, redirects or manager APIs. */
export function validateNativeExitRequest(
  method: string,
  path: string,
  body: unknown,
  headers: Headers,
): void {
  const url = new URL(path, "https://bridge.invalid/");
  if (
    url.origin !== "https://bridge.invalid" ||
    /[%\\]/.test(url.pathname) ||
    url.pathname.includes("..")
  )
    throw new Error("Invalid exit route.");
  const route = url.pathname.slice(1),
    parts = route.split("/");
  if (
    parts[0] === "partners" &&
    parts[1] === "public" &&
    UUID.test(parts[2] ?? "") &&
    parts[3] === "connections" &&
    parts.length === 5
  ) {
    const op = parts[4];
    if (method === "GET" && op === "exit-context") {
      if (
        !/^Bearer tse_[0-9a-f-]{36}_[a-f0-9]{64}$/.test(
          headers.get("authorization") ?? "",
        ) ||
        [...url.searchParams.keys()].some(
          (k) =>
            ![
              "strategyId",
              "strategyTable",
              "proxy",
              "expectedGeneration",
            ].includes(k),
        ) ||
        [...url.searchParams.keys()].some(
          (k) => url.searchParams.getAll(k).length !== 1,
        ) ||
        !UUID.test(url.searchParams.get("strategyId") ?? "") ||
        !["strategies", "custom_strategies"].includes(
          url.searchParams.get("strategyTable") ?? "",
        ) ||
        !address.test(url.searchParams.get("proxy") ?? "") ||
        (url.searchParams.has("expectedGeneration") &&
          !UUID.test(url.searchParams.get("expectedGeneration") ?? ""))
      )
        throw new Error("Invalid exit context request.");
      return;
    }
    if (method !== "POST" || url.search || headers.has("authorization"))
      throw new Error("Invalid exit proof request.");
    const value = record(body);
    if (
      op === "challenges" &&
      only(value, [
        "action",
        "purpose",
        "signerAddress",
        "managedWalletAddress",
      ]) &&
      value.action === "read" &&
      value.purpose === "exit" &&
      address.test(String(value.signerAddress)) &&
      address.test(String(value.managedWalletAddress))
    )
      return;
    if (
      op === "read" &&
      only(value, ["challengeId", "signature"]) &&
      UUID.test(String(value.challengeId)) &&
      signature.test(String(value.signature))
    )
      return;
    throw new Error("Invalid exit proof request.");
  }
  if (
    url.search ||
    headers.has("authorization") ||
    !signature.test(headers.get("x-signature") ?? "") ||
    !address.test(headers.get("x-wallet-address") ?? "") ||
    !address.test(headers.get("x-signer-address") ?? "") ||
    !headers.get("x-message") ||
    headers.get("x-message")!.length > 10000 ||
    /[\r\n]/.test(headers.get("x-message")!)
  )
    throw new Error("Invalid exit signed request.");
  const value = method === "GET" ? {} : record(body);
  if (
    route === "membership/unregister" &&
    method === "POST" &&
    Object.keys(value).length === 0
  )
    return;
  if (
    method === "POST" &&
    /^fees\/me\/strategies\/[^/]+\/exit-checkout$/.test(route) &&
    UUID.test(parts[3]) &&
    Object.keys(value).length === 0
  )
    return;
  if (
    method === "POST" &&
    /^fees\/me\/bundles\/[^/]+\/submitted$/.test(route) &&
    UUID.test(parts[3]) &&
    only(value, [
      "transactionHash",
      "blockHash",
      "blockNumber",
      "extrinsicIndex",
    ]) &&
    HASH.test(String(value.transactionHash)) &&
    HASH.test(String(value.blockHash)) &&
    Number.isSafeInteger(value.blockNumber) &&
    Number(value.blockNumber) >= 0 &&
    Number.isSafeInteger(value.extrinsicIndex) &&
    Number(value.extrinsicIndex) >= 0
  )
    return;
  throw new Error("Unsupported exit route.");
}
export function createNativeExitBridge(options: {
  apiOrigin: string;
  prefix: string;
  fetch: typeof fetch;
  authorize(request: Request): Promise<boolean>;
}) {
  const origin = new URL(options.apiOrigin);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(origin.hostname)
      )) ||
    !/^\/[a-zA-Z0-9/_-]+$/.test(options.prefix) ||
    options.prefix.endsWith("/") ||
    options.prefix.includes("..")
  )
    throw new Error("Invalid exit bridge configuration.");
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (
        !url.pathname.startsWith(options.prefix + "/") ||
        !["GET", "POST"].includes(request.method)
      )
        return new Response(null, { status: 404 });
      const path = url.pathname.slice(options.prefix.length + 1) + url.search;
      const body =
        request.method === "POST"
          ? await boundedJson(new Response(request.body), 30000)
          : undefined;
      validateNativeExitRequest(request.method, path, body, request.headers);
      if (!(await options.authorize(request)))
        return new Response(null, { status: 403 });
      const headers = new Headers({ accept: "application/json" });
      for (const name of [
        "authorization",
        "x-signature",
        "x-message",
        "x-wallet-address",
        "x-signer-address",
      ]) {
        const v = request.headers.get(name);
        if (v) headers.set(name, v);
      }
      if (body !== undefined) headers.set("content-type", "application/json");
      const result = await options.fetch(`${origin.origin}/api/v1/${path}`, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(15000),
      });
      return Response.json(await boundedJson(result), {
        status: result.status,
        headers: {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    } catch {
      return Response.json(
        { code: "EXIT_REQUEST_UNAVAILABLE" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
  };
}
