import type { Wallet, AllocationDependencies } from "./types.ts";
import {
  isReadableWalletMessage,
  validateReadableMessage,
  stringToHex,
  signingMessageHeader,
} from "./encoding.ts";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
export const INITIAL_ALLOCATION_CONSENT =
  "Authorize one backend-managed initial rebalance for this strategy. An uncertain submission will not be retried automatically.";
export const INITIAL_ALLOCATION_RENEWAL_CONSENT =
  "Renew my expired initial rebalance approval for one hour. The previous request never started. An uncertain submission will not be retried automatically.";
const statuses = [
  "queued",
  "running",
  "completed",
  "no_op",
  "blocked",
  "needs_review",
  "cancelled",
] as const;
export interface InitialAllocationReceipt {
  jobId: string;
  correlationId: string;
  status: (typeof statuses)[number];
  reason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  successfulOperations: number;
  failedOperations: number;
}
export interface InitialAllocationAccess {
  job: InitialAllocationReceipt;
  readToken: string;
  readExpiresAt: string;
}
export interface InitialAllocationWallet {
  signer: Wallet["signer"];
  signerAddress: string;
  managedWalletAddress: string;
  genesisHash: string;
  strategyId: string;
  strategyTable: "strategies" | "custom_strategies";
  partnerSessionId?: string;
  renewCorrelationId?: string;
  assertCurrentFlow: () => void;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid initial allocation response.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).some((key) => !expected.includes(key)))
    throw new Error("Unexpected initial allocation fields.");
}
function text(value: unknown, max: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    (pattern && !pattern.test(value))
  )
    throw new Error("Invalid initial allocation response.");
  return value;
}
function date(value: unknown): string {
  const result = text(value, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw new Error("Invalid initial allocation timestamp.");
  return result;
}
export function parseInitialAllocationReceipt(
  raw: unknown,
): InitialAllocationReceipt {
  const value = object(raw);
  keys(value, [
    "jobId",
    "correlationId",
    "status",
    "reason",
    "createdAt",
    "startedAt",
    "finishedAt",
    "successfulOperations",
    "failedOperations",
  ]);
  if (
    !statuses.includes(value.status as InitialAllocationReceipt["status"]) ||
    !Number.isSafeInteger(value.successfulOperations) ||
    Number(value.successfulOperations) < 0 ||
    !Number.isSafeInteger(value.failedOperations) ||
    Number(value.failedOperations) < 0
  )
    throw new Error("Invalid initial allocation status.");
  const result = {
    jobId: text(value.jobId, 36, UUID),
    correlationId: text(value.correlationId, 36, UUID),
    status: value.status as InitialAllocationReceipt["status"],
    reason: value.reason === null ? null : text(value.reason, 500),
    createdAt: date(value.createdAt),
    startedAt: value.startedAt === null ? null : date(value.startedAt),
    finishedAt: value.finishedAt === null ? null : date(value.finishedAt),
    successfulOperations: Number(value.successfulOperations),
    failedOperations: Number(value.failedOperations),
  };
  const created = Date.parse(result.createdAt),
    started = result.startedAt ? Date.parse(result.startedAt) : null,
    finished = result.finishedAt ? Date.parse(result.finishedAt) : null;
  const terminal = [
    "completed",
    "no_op",
    "blocked",
    "needs_review",
    "cancelled",
  ].includes(result.status);
  if (
    (started !== null && started < created) ||
    (finished !== null && finished < (started ?? created)) ||
    (result.status === "queued" && (started !== null || finished !== null)) ||
    (result.status === "running" && (started === null || finished !== null)) ||
    (terminal && finished === null) ||
    (result.status === "completed" &&
      (started === null ||
        result.successfulOperations === 0 ||
        result.failedOperations !== 0)) ||
    (result.status === "no_op" &&
      (result.successfulOperations !== 0 || result.failedOperations !== 0))
  )
    throw new Error("Initial allocation outcome is inconsistent.");
  return result;
}
export function parseInitialAllocationChallenge(
  raw: unknown,
  sameWallet: (a: string, b: string) => boolean = (a, b) => a === b,
) {
  const value = object(raw);
  const message = text(value.message, 10_000);
  const readable = isReadableWalletMessage(message);
  keys(
    value,
    readable
      ? [
          "schemaVersion",
          "message",
          "requestId",
          "expiresAt",
          "payload",
          "signingBytes",
          "request",
          "walletAddress",
          "signerAddress",
        ]
      : ["message", "requestId", "expiresAt"],
  );
  const result = {
    message,
    requestId: text(value.requestId, 36, UUID),
    expiresAt: date(value.expiresAt),
    payload: undefined as Record<string, unknown> | undefined,
  };
  if (!readable) return result;
  const request = object(value.request);
  keys(request, ["method", "path", "body"]);
  if (
    value.schemaVersion !== 2 ||
    request.method !== "POST" ||
    request.path !== "/api/v1/membership/initial-allocation" ||
    Object.keys(object(request.body)).length
  )
    throw new Error("Invalid readable allocation request.");
  validateReadableMessage(
    message,
    result.requestId,
    text(value.signingBytes, 10_000),
  );
  const payload = object(value.payload);
  if (
    !sameWallet(
      text(value.walletAddress, 50),
      String(payload.managedWalletAddress),
    ) ||
    !sameWallet(text(value.signerAddress, 50), String(payload.signerAddress))
  )
    throw new Error("Allocation identities did not match.");
  return {
    ...result,
    payload,
    schemaVersion: 2,
    signingBytes: value.signingBytes,
    request,
    walletAddress: value.walletAddress,
    signerAddress: value.signerAddress,
  };
}
export function parseInitialAllocationAccess(
  raw: unknown,
  now: () => number = Date.now,
): InitialAllocationAccess {
  const value = object(raw);
  keys(value, ["job", "readToken", "readExpiresAt"]);
  const readExpiresAt = date(value.readExpiresAt);
  if (
    Date.parse(readExpiresAt) <= now() ||
    Date.parse(readExpiresAt) > now() + 24 * 60 * 60_000 + 30_000
  )
    throw new Error("Invalid allocation read access.");
  return {
    job: parseInitialAllocationReceipt(value.job),
    readToken: text(value.readToken, 256, TOKEN),
    readExpiresAt,
  };
}
/** A challenge denial occurs before signing/submission; it is not an uncertain trade result. */
export class InitialAllocationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitialAllocationUnavailableError";
  }
}
/** Validate every applied identifier before asking the wallet for a separate allocation approval. */
export async function requestInitialAllocation(
  wallet: InitialAllocationWallet,
  dependencies: AllocationDependencies,
): Promise<InitialAllocationAccess> {
  const {
    request,
    now,
    sameWallet,
    sha256,
    readable: useReadable,
  } = dependencies;
  wallet.assertCurrentFlow();
  if (
    !wallet.signer.signRaw ||
    !UUID.test(wallet.strategyId) ||
    !HASH.test(wallet.genesisHash) ||
    !["strategies", "custom_strategies"].includes(wallet.strategyTable) ||
    (wallet.partnerSessionId && !UUID.test(wallet.partnerSessionId)) ||
    (wallet.renewCorrelationId !== undefined &&
      !UUID.test(wallet.renewCorrelationId))
  )
    throw new Error(
      "Initial allocation cannot be approved for this wallet or strategy.",
    );
  const challenge = parseInitialAllocationChallenge(
    await request("/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: wallet.managedWalletAddress,
        signerAddress: wallet.signerAddress,
        strategyId: wallet.strategyId,
        strategyTable: wallet.strategyTable,
        ...(wallet.partnerSessionId
          ? { partnerSessionId: wallet.partnerSessionId }
          : {}),
        ...(wallet.renewCorrelationId
          ? { renewCorrelationId: wallet.renewCorrelationId }
          : {}),
        ...(useReadable ? { messageFormat: "readable" } : {}),
      }),
    }),
    sameWallet,
  );
  const message = text(challenge.message, 10_000);
  const requestId = text(challenge.requestId, 36, UUID);
  const expiresAt = Date.parse(date(challenge.expiresAt));
  if (useReadable && !isReadableWalletMessage(message))
    throw new Error("Readable wallet signing is unavailable. Please retry.");
  if (isReadableWalletMessage(message))
    validateReadableMessage(message, requestId);
  const envelope = object(
    isReadableWalletMessage(message) ? challenge.payload : JSON.parse(message),
  );
  keys(envelope, [
    "action",
    "timestamp",
    "nonce",
    "signerAddress",
    "managedWalletAddress",
    "data",
  ]);
  const data = object(envelope.data);
  keys(data, [
    "version",
    "method",
    "route",
    "bodyHash",
    "genesisHash",
    "expiresAt",
    "requestId",
    "strategyId",
    "strategyTable",
    "strategyHash",
    "partnerSessionId",
    "renewCorrelationId",
    "consent",
  ]);
  const digest = await sha256("{}");
  const currentTime = now();
  if (
    envelope.action !== "request_initial_allocation" ||
    envelope.nonce !== requestId ||
    !Number.isSafeInteger(envelope.timestamp) ||
    Number(envelope.timestamp) > currentTime + 30_000 ||
    Number(envelope.timestamp) < currentTime - 6 * 60_000 ||
    !sameWallet(String(envelope.signerAddress), wallet.signerAddress) ||
    !sameWallet(
      String(envelope.managedWalletAddress),
      wallet.managedWalletAddress,
    ) ||
    data.version !== 1 ||
    data.method !== "POST" ||
    data.route !== "/api/v1/membership/initial-allocation" ||
    data.bodyHash !== digest ||
    data.genesisHash !== wallet.genesisHash ||
    data.expiresAt !== expiresAt ||
    expiresAt <= currentTime ||
    expiresAt > currentTime + 6 * 60_000 ||
    data.requestId !== requestId ||
    data.strategyId !== wallet.strategyId ||
    data.strategyTable !== wallet.strategyTable ||
    !DIGEST.test(String(data.strategyHash)) ||
    data.partnerSessionId !== wallet.partnerSessionId ||
    data.renewCorrelationId !== wallet.renewCorrelationId ||
    data.consent !==
      (wallet.renewCorrelationId
        ? INITIAL_ALLOCATION_RENEWAL_CONSENT
        : INITIAL_ALLOCATION_CONSENT)
  ) {
    throw new Error(
      "The allocation approval did not match this wallet, network, strategy, or action.",
    );
  }
  wallet.assertCurrentFlow();
  const signed = await wallet.signer.signRaw({
    address: wallet.signerAddress,
    data: stringToHex(message),
    type: "bytes",
  });
  wallet.assertCurrentFlow();
  if (expiresAt <= now())
    throw new Error("Allocation approval expired while signing.");
  const signature = text(signed.signature, 260, /^0x[0-9a-f]{128,132}$/i);
  const result = await request("", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature": signature,
      "x-message": signingMessageHeader(message),
      "x-wallet-address": wallet.managedWalletAddress,
      "x-signer-address": wallet.signerAddress,
      "x-correlation-id": requestId,
    },
    body: "{}",
  });
  wallet.assertCurrentFlow();
  const access = parseInitialAllocationAccess(result, now);
  // A first request preserves the membership ticket correlation. Renewal rotates it to this nonce.
  if (wallet.renewCorrelationId && access.job.correlationId !== requestId)
    throw new Error("Allocation acceptance belongs to another request.");
  return access;
}
export async function fetchInitialAllocation(
  access: InitialAllocationAccess,
  dependencies: AllocationDependencies,
): Promise<InitialAllocationReceipt> {
  const { request, now } = dependencies;
  if (
    !UUID.test(access.job.jobId) ||
    !TOKEN.test(access.readToken) ||
    Date.parse(access.readExpiresAt) <= now()
  )
    throw new Error(
      "Allocation status access expired. Recover it with your wallet.",
    );
  const job = parseInitialAllocationReceipt(
    await request(`/${access.job.jobId}`, {
      method: "GET",
      headers: { "x-initial-allocation-read-token": access.readToken },
    }),
  );
  if (
    job.jobId !== access.job.jobId ||
    job.correlationId !== access.job.correlationId
  )
    throw new Error("Allocation status did not match your request.");
  return job;
}
export function canRenewInitialAllocation(
  job: InitialAllocationReceipt | null,
): boolean {
  return (
    !!job &&
    job.status === "blocked" &&
    job.reason === "authorization_expired" &&
    job.startedAt === null &&
    job.successfulOperations === 0 &&
    job.failedOperations === 0
  );
}
export function initialAllocationMessage(
  job: InitialAllocationReceipt,
): string {
  switch (job.status) {
    case "queued":
      return "Your initial rebalance is waiting to start.";
    case "running":
      return "Your initial rebalance is in progress.";
    case "completed":
      return "Your initial rebalance is complete.";
    case "no_op":
      return "Your holdings matched the strategy at the initial rebalance. No trades were needed.";
    case "blocked":
      return canRenewInitialAllocation(job)
        ? "Your approval expired before the rebalance started. No trades were submitted by this request. Renew your approval to allow one more hour. Your membership is unchanged."
        : "Your initial rebalance couldn’t start. Contact TrustedStake for help.";
    case "needs_review":
      return "Your initial rebalance needs review. Trades will not be repeated automatically.";
    case "cancelled":
      return "Your initial rebalance was cancelled. Your membership is unchanged.";
  }
}
