import { UUID, TOKEN, HASH, record } from "./contracts.ts";

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{47,50}$/;
const signature = (value: unknown) =>
  typeof value === "string" && /^0x[0-9a-f]{128,132}$/i.test(value);
const uuid = (value: unknown) => typeof value === "string" && UUID.test(value);
const bounded = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const integer = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const hasKeys = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((key) => keys.includes(key));
export function validatePartnerRequest(
  method: string,
  path: string[],
  search: URLSearchParams,
  body: unknown,
  authorization: string | null,
): void {
  const [kind, id, action] = path;
  if (path.length > 4 || !uuid(id)) throw new Error("Invalid join route.");
  if ([...search.keys()].some((key) => !["cursor", "limit"].includes(key)))
    throw new Error("Unexpected query field.");
  if (search.has("cursor") && !uuid(search.get("cursor")))
    throw new Error("Invalid cursor.");
  if (
    search.has("limit") &&
    !/^(?:[1-9][0-9]?|100)$/.test(search.get("limit") ?? "")
  )
    throw new Error("Invalid limit.");
  if (authorization?.startsWith("Bearer tsp_"))
    throw new Error("Partner API keys must stay on the partner server.");
  if (authorization && !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization))
    throw new Error("Invalid session credential.");
  if (kind === "public" && action === "connections" && path.length === 4) {
    const operation = path[3];
    if (search.size) throw new Error("Unexpected connection query.");
    if (
      method === "GET" &&
      ["memberships", "portfolio"].includes(operation) &&
      authorization
    )
      return;
    if (method !== "POST") throw new Error("Invalid connection route.");
    const value = record(body);
    if (
      operation === "challenges" &&
      hasKeys(value, [
        "action",
        "signerAddress",
        "managedWalletAddress",
        "messageFormat",
      ]) &&
      (value.messageFormat === undefined ||
        value.messageFormat === "readable") &&
      ["read", "revoke"].includes(String(value.action)) &&
      WALLET.test(String(value.signerAddress)) &&
      WALLET.test(String(value.managedWalletAddress))
    )
      return;
    if (
      ["read", "revoke"].includes(operation) &&
      hasKeys(value, ["challengeId", "signature"]) &&
      uuid(value.challengeId) &&
      signature(value.signature)
    )
      return;
    throw new Error("Invalid connection request.");
  }
  if (path.length === 4) throw new Error("Invalid join route.");
  if (method === "GET") {
    const allowed =
      (kind === "public" && ["strategies", "frame-config"].includes(action)) ||
      (kind === "join-sessions" &&
        (path.length === 2 || ["context", "frame-config"].includes(action)));
    if (!allowed || (search.size > 0 && action !== "strategies"))
      throw new Error("Invalid join route.");
    if (kind === "join-sessions" && action !== "frame-config" && !authorization)
      throw new Error("Session access is required.");
    return;
  }
  if (method !== "POST" || search.size > 0)
    throw new Error("Invalid join route.");
  const v = record(body);
  if ((kind === "public" || kind === "launch") && action === "join-sessions") {
    const keys = [
      "idempotencyKey",
      "returnDestinationId",
      "state",
      ...(kind === "public" ? ["strategyRef"] : []),
    ];
    if (
      !hasKeys(v, keys) ||
      !uuid(v.idempotencyKey) ||
      (kind === "public" && !bounded(v.strategyRef, 100)) ||
      (v.returnDestinationId !== undefined &&
        !bounded(v.returnDestinationId, 64)) ||
      (v.state !== undefined && !bounded(v.state, 500))
    )
      throw new Error("Invalid session launch.");
    return;
  }
  if (kind !== "join-sessions") throw new Error("Invalid join route.");
  if (
    !["exchange", "recovery-challenges", "recover"].includes(action) &&
    !authorization
  )
    throw new Error("Session access is required.");
  if (
    action === "exchange" &&
    hasKeys(v, ["launchToken"]) &&
    typeof v.launchToken === "string" &&
    TOKEN.test(v.launchToken)
  )
    return;
  if (action === "continuation" && Object.keys(v).length === 0) return;
  if (
    ["wallet-proof", "register", "cancel", "recover"].includes(action) &&
    hasKeys(v, ["challengeId", "signature"]) &&
    uuid(v.challengeId) &&
    signature(v.signature)
  )
    return;
  if (
    action === "checkpoint" &&
    hasKeys(v, [
      "phase",
      "transactionHash",
      "fromBlock",
      "stage",
      "blockHash",
      "callHash",
    ]) &&
    (v.stage === undefined ||
      ["proxy", "allocation"].includes(String(v.stage))) &&
    (v.blockHash === undefined || HASH.test(String(v.blockHash))) &&
    (v.callHash === undefined || HASH.test(String(v.callHash))) &&
    [
      "awaiting_confirmation",
      "submitted",
      "verifying",
      "action_required",
    ].includes(String(v.phase)) &&
    (v.transactionHash === undefined ||
      (typeof v.transactionHash === "string" &&
        HASH.test(v.transactionHash))) &&
    (v.fromBlock === undefined || integer(v.fromBlock))
  )
    return;
  if (["challenges", "recovery-challenges"].includes(action)) {
    if (
      !hasKeys(
        v,
        action === "challenges"
          ? [
              "action",
              "signerAddress",
              "managedWalletAddress",
              "data",
              "messageFormat",
            ]
          : ["signerAddress", "managedWalletAddress", "messageFormat"],
      ) ||
      (v.messageFormat !== undefined && v.messageFormat !== "readable") ||
      !WALLET.test(String(v.signerAddress)) ||
      !WALLET.test(String(v.managedWalletAddress))
    )
      throw new Error("Invalid wallet proof request.");
    if (action === "recovery-challenges") return;
    const data = record(v.data);
    if (
      v.action === "wallet-proof" &&
      hasKeys(data, ["discloseMembership"]) &&
      typeof data.discloseMembership === "boolean"
    )
      return;
    if (
      v.action === "register" &&
      hasKeys(data, [
        "fromBlock",
        "fromTimestamp",
        "feeTermsHash",
        "membershipSharing",
      ]) &&
      (data.membershipSharing === undefined ||
        data.membershipSharing === "partner_membership" ||
        data.membershipSharing === "none") &&
      integer(data.fromBlock) &&
      integer(data.fromTimestamp) &&
      (data.feeTermsHash === undefined || HASH.test(String(data.feeTermsHash)))
    )
      return;
    if (v.action === "cancel" && Object.keys(data).length === 0) return;
  }
  throw new Error("Invalid join request.");
}
