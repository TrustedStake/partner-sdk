import {
  parseInitialAllocationReceipt,
  type InitialAllocationReceipt,
} from "./allocation.ts";
import type { PublicStrategyFeePolicy } from "./fees.ts";
import { assertReviewableFeePolicy } from "./fees.ts";

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HASH = /^0x[0-9a-f]{64}$/i;
export const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{47,50}$/;
export type PartnerCard = {
  strategyRef: string;
  name: string;
  description: string;
  accessMode: "public" | "unlisted" | "restricted";
  availability: "joinable" | "paused" | "closed";
  joinUrl: string | null;
  updatedAt: string;
};
export type Catalog = {
  items: PartnerCard[];
  nextCursor: string | null;
  asOf: string;
};
export type SessionLaunch = {
  sessionId: string;
  hostedUrl: string;
  embedUrl: string;
  expiresAt: string;
};
export type SessionAccess = {
  sessionId: string;
  observerToken: string;
  actionToken: string;
  expiresAt: string;
};
export type Checkpoint = {
  stage?: "proxy" | "allocation";
  blockHash?: string;
  callHash?: string;
  phase:
    | "awaiting_confirmation"
    | "submitted"
    | "verifying"
    | "action_required";
  transactionHash?: string;
  fromBlock?: number;
};
export type SessionStatus = {
  sessionId: string;
  strategyRef: string;
  status:
    | "open"
    | "closed"
    | "awaiting_wallet"
    | "awaiting_confirmation"
    | "submitted"
    | "verifying"
    | "action_required"
    | "membership_accepted"
    | "cancelled"
    | "expired";
  membership: {
    registration: "pending" | "accepted";
    current: "not_member" | "active" | "left" | "suspended" | "unknown";
    acceptedAt: string | null;
    asOf: string;
    walletAddress?: string;
  } | null;
  allocation: { status: "unknown" };
  checkpoint: Checkpoint | null;
  checkpoints: Checkpoint[];
  nextAction: "connect_wallet" | "resume" | "manage" | "none";
  expiresAt: string;
  receiptExpiresAt: string | null;
};
export type JoinContext = {
  sessionId: string;
  partnerId: string;
  partnerName: string;
  strategyRef: string;
  strategyId: string;
  strategyTable: "strategies" | "custom_strategies";
  proxy: string;
  network: "finney";
  genesisHash: string;
  name: string;
  description: string;
  accessMode: "public" | "unlisted" | "restricted";
  availability: "joinable" | "paused" | "closed";
  feeTermsHash: string | null;
  managedWalletAddress: string | null;
  signerAddress: string | null;
  walletVerified?: boolean;
  membershipSharingAvailable?: boolean;
  membershipSharingScope?: "partner_membership";
  initialAllocation?:
    | {
        status:
          | "ready"
          | "confirmation_required"
          | "repair_required"
          | "unavailable";
      }
    | { status: "existing"; job: InitialAllocationReceipt };
  initialAllocationRepair?: {
    fromBlock: number;
    fromTimestamp: number;
    expiresAt: string;
  };
  returnUrl: string | null;
  allowedOrigins: string[];
  expiresAt: string;
  ownerWalletAddress: string | null;
  feePolicy: PublicStrategyFeePolicy | null;
  targetConstituents?: { subnetWeights: Record<string, number> };
  rebalancingRules?: {
    threshold: number;
    maxSlippage: number;
    minBalance: number;
  };
};
export type Challenge = {
  payload?: Record<string, unknown>;
  challengeId: string;
  message: string;
  signingBytes: string;
  expiresAt: string;
};
export type FrameConfig = {
  partnerId: string;
  partnerName: string;
  allowedOrigins: string[];
  features?: string[];
};

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid partner service response.");
  return value as Record<string, unknown>;
}
export function textValue(value: unknown, max = 256, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (pattern && !pattern.test(value))
  )
    throw new Error("Invalid partner service response.");
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new Error("Invalid partner service response.");
  return value as T;
}
function date(value: unknown): string {
  const result = textValue(value, 40);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error("Invalid partner service timestamp.");
  return result;
}
function nullable<T>(value: unknown, parser: (v: unknown) => T): T | null {
  return value === null ? null : parser(value);
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max)
    throw new Error("Invalid partner service number.");
  return Number(value);
}
export function exactOrigin(value: unknown): string {
  const origin = textValue(value, 300);
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/^[a-z0-9.-]+$/i.test(url.hostname)
  )
    throw new Error("Invalid registered origin.");
  return origin;
}
function httpsUrl(value: unknown): string {
  const url = new URL(textValue(value, 2048));
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid partner URL.");
  return url.href;
}
function origins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30)
    throw new Error("Invalid registered origins.");
  return value.map(exactOrigin);
}
export const PARTNER_FEATURES = [
  "catalog:read",
  "sessions:create",
  "sessions:read",
  "memberships:read",
  "memberships:manage",
  "initial-allocation:request",
] as const;
function parsePartnerFeatures(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    new Set(value).size !== value.length
  )
    throw new Error("Invalid partner features.");
  const features: string[] = [];
  for (const item of value) {
    const feature = textValue(
      item,
      64,
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    );
    if ((PARTNER_FEATURES as readonly string[]).includes(feature))
      features.push(feature);
  }
  return features;
}
export function parseFrameConfig(value: unknown): FrameConfig {
  const v = record(value);
  return {
    partnerId: textValue(v.partnerId, 36, UUID),
    partnerName: textValue(v.partnerName, 160),
    allowedOrigins: origins(v.allowedOrigins),
    ...(v.features === undefined
      ? {}
      : { features: parsePartnerFeatures(v.features) }),
  };
}
export function parseCatalog(value: unknown): Catalog {
  const v = record(value);
  if (!Array.isArray(v.items) || v.items.length > 100)
    throw new Error("Invalid partner catalog.");
  return {
    items: v.items.map((item) => {
      const c = record(item);
      return {
        strategyRef: textValue(c.strategyRef, 100),
        name: textValue(c.name, 200),
        description: textValue(c.description, 5000),
        accessMode: oneOf(c.accessMode, ["public", "unlisted", "restricted"]),
        availability: oneOf(c.availability, ["joinable", "paused", "closed"]),
        joinUrl: nullable(c.joinUrl, httpsUrl),
        updatedAt: date(c.updatedAt),
      };
    }),
    nextCursor: nullable(v.nextCursor, (value) => textValue(value, 36, UUID)),
    asOf: date(v.asOf),
  };
}
export function parseLaunch(value: unknown): SessionLaunch {
  const v = record(value);
  const sessionId = textValue(v.sessionId, 36, UUID);
  const hostedUrl = httpsUrl(v.hostedUrl),
    embedUrl = httpsUrl(v.embedUrl);
  if (
    new URL(hostedUrl).pathname !== `/connect/sessions/${sessionId}` ||
    new URL(embedUrl).pathname !== `/embed/partners/sessions/${sessionId}` ||
    new URL(hostedUrl).origin !== new URL(embedUrl).origin
  )
    throw new Error("Invalid join destination.");
  return { sessionId, hostedUrl, embedUrl, expiresAt: date(v.expiresAt) };
}
export function parseAccess(value: unknown): SessionAccess {
  const v = record(value);
  return {
    sessionId: textValue(v.sessionId, 36, UUID),
    observerToken: textValue(v.observerToken, 256, TOKEN),
    actionToken: textValue(v.actionToken, 256, TOKEN),
    expiresAt: date(v.expiresAt),
  };
}
function parseCheckpoint(value: unknown): Checkpoint {
  const c = record(value);
  return {
    ...(c.stage === undefined
      ? {}
      : { stage: oneOf(c.stage, ["proxy", "allocation"] as const) }),
    ...(c.blockHash === undefined
      ? {}
      : { blockHash: textValue(c.blockHash, 66, HASH) }),
    ...(c.callHash === undefined
      ? {}
      : { callHash: textValue(c.callHash, 66, HASH) }),
    phase: oneOf(c.phase, [
      "awaiting_confirmation",
      "submitted",
      "verifying",
      "action_required",
    ]),
    ...(c.transactionHash === undefined
      ? {}
      : { transactionHash: textValue(c.transactionHash, 66, HASH) }),
    ...(c.fromBlock === undefined ? {} : { fromBlock: integer(c.fromBlock) }),
  };
}
function parseCheckpoints(value: unknown): Checkpoint[] {
  if (!Array.isArray(value) || value.length > 32)
    throw new Error("Invalid checkpoint history.");
  return value.map(parseCheckpoint);
}
export function parseStatus(value: unknown): SessionStatus {
  const v = record(value);
  return {
    sessionId: textValue(v.sessionId, 36, UUID),
    strategyRef: textValue(v.strategyRef, 100),
    status: oneOf(v.status, [
      "open",
      "closed",
      "awaiting_wallet",
      "awaiting_confirmation",
      "submitted",
      "verifying",
      "action_required",
      "membership_accepted",
      "cancelled",
      "expired",
    ]),
    membership: nullable(v.membership, (value) => {
      const m = record(value);
      return {
        registration: oneOf(m.registration, ["pending", "accepted"]),
        current: oneOf(m.current, [
          "not_member",
          "active",
          "left",
          "suspended",
          "unknown",
        ]),
        acceptedAt: nullable(m.acceptedAt, date),
        asOf: date(m.asOf),
        ...(m.walletAddress === undefined
          ? {}
          : { walletAddress: textValue(m.walletAddress, 50, ADDRESS) }),
      };
    }),
    allocation: { status: oneOf(record(v.allocation).status, ["unknown"]) },
    checkpoint: nullable(v.checkpoint, parseCheckpoint),
    checkpoints: parseCheckpoints(v.checkpoints),
    nextAction: oneOf(v.nextAction, [
      "connect_wallet",
      "resume",
      "manage",
      "none",
    ]),
    expiresAt: date(v.expiresAt),
    receiptExpiresAt: nullable(v.receiptExpiresAt, date),
  };
}
export function parseContext(value: unknown): JoinContext {
  const v = record(value);
  const strategyId = textValue(v.strategyId, 36, UUID);
  const walletVerified =
    v.walletVerified === undefined ? true : v.walletVerified;
  if (
    typeof walletVerified !== "boolean" ||
    (v.membershipSharingAvailable !== undefined &&
      typeof v.membershipSharingAvailable !== "boolean")
  )
    throw new Error("Invalid session authorization state.");
  if (
    v.membershipSharingScope !== undefined &&
    v.membershipSharingScope !== "partner_membership"
  )
    throw new Error("Invalid membership sharing scope.");
  if (
    !walletVerified &&
    (v.managedWalletAddress !== null ||
      v.signerAddress !== null ||
      v.accessMode === "restricted")
  )
    throw new Error("Invalid unverified join context.");

  let initialAllocationRepair: JoinContext["initialAllocationRepair"];
  if (v.initialAllocationRepair != null) {
    const repair = record(v.initialAllocationRepair);
    if (
      !walletVerified ||
      Object.keys(repair).some(
        (key) => !["fromBlock", "fromTimestamp", "expiresAt"].includes(key),
      ) ||
      !Number.isSafeInteger(repair.fromBlock) ||
      Number(repair.fromBlock) < 0 ||
      !Number.isSafeInteger(repair.fromTimestamp) ||
      Number(repair.fromTimestamp) < 0
    )
      throw new Error("Invalid membership confirmation.");
    initialAllocationRepair = {
      fromBlock: Number(repair.fromBlock),
      fromTimestamp: Number(repair.fromTimestamp),
      expiresAt: date(repair.expiresAt),
    };
  }
  let initialAllocation: JoinContext["initialAllocation"];
  if (v.initialAllocation !== undefined) {
    const allocation = record(v.initialAllocation);
    const status = oneOf(allocation.status, [
      "ready",
      "confirmation_required",
      "repair_required",
      "existing",
      "unavailable",
    ] as const);
    if (
      !walletVerified ||
      Object.keys(allocation).some(
        (key) => key !== "status" && !(status === "existing" && key === "job"),
      )
    )
      throw new Error("Invalid initial rebalance availability.");
    if (status === "repair_required" && !initialAllocationRepair)
      throw new Error("Missing membership confirmation anchor.");
    initialAllocation =
      status === "existing"
        ? { status, job: parseInitialAllocationReceipt(allocation.job) }
        : { status };
  }
  const feePolicy =
    v.feePolicy === null
      ? null
      : (record(v.feePolicy) as unknown as PublicStrategyFeePolicy);
  if (feePolicy) assertReviewableFeePolicy(feePolicy, strategyId);
  let targetConstituents: JoinContext["targetConstituents"];
  if (v.targetConstituents !== undefined && v.targetConstituents !== null) {
    const weights = record(record(v.targetConstituents).subnetWeights);
    if (
      Object.keys(weights).length > 1024 ||
      Object.entries(weights).some(
        ([key, weight]) =>
          !/^\d{1,5}$/.test(key) ||
          typeof weight !== "number" ||
          !Number.isFinite(weight) ||
          weight < 0 ||
          weight > 100,
      )
    )
      throw new Error("Invalid strategy allocation.");
    targetConstituents = { subnetWeights: weights as Record<string, number> };
  }
  let rebalancingRules: JoinContext["rebalancingRules"];
  if (v.rebalancingRules !== undefined && v.rebalancingRules !== null) {
    const raw = record(v.rebalancingRules);
    const r = {
      threshold: raw.threshold,
      maxSlippage: raw.maxSlippage,
      minBalance: raw.minBalance === undefined ? 0 : Number(raw.minBalance),
    };
    if (
      [r.threshold, r.maxSlippage, r.minBalance].some(
        (x) => typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1e9,
      )
    )
      throw new Error("Invalid rebalancing policy.");
    rebalancingRules = r as JoinContext["rebalancingRules"];
  }
  return {
    sessionId: textValue(v.sessionId, 36, UUID),
    partnerId: textValue(v.partnerId, 36, UUID),
    partnerName: textValue(v.partnerName, 160),
    strategyRef: textValue(v.strategyRef, 100),
    strategyId,
    strategyTable: oneOf(v.strategyTable, ["strategies", "custom_strategies"]),
    proxy: textValue(v.proxy, 50, ADDRESS),
    network: oneOf(v.network, ["finney"]),
    genesisHash: textValue(v.genesisHash, 66, HASH),
    name: textValue(v.name, 200),
    description: textValue(v.description, 5000),
    accessMode: oneOf(v.accessMode, ["public", "unlisted", "restricted"]),
    availability: oneOf(v.availability, ["joinable", "paused", "closed"]),
    feeTermsHash: nullable(v.feeTermsHash, (value) =>
      textValue(value, 66, HASH),
    ),
    managedWalletAddress: walletVerified
      ? textValue(v.managedWalletAddress, 50, ADDRESS)
      : null,
    signerAddress: walletVerified
      ? textValue(v.signerAddress, 50, ADDRESS)
      : null,
    walletVerified,
    membershipSharingAvailable: v.membershipSharingAvailable === true,
    ...(v.membershipSharingScope === "partner_membership"
      ? { membershipSharingScope: "partner_membership" as const }
      : {}),
    ...(initialAllocation ? { initialAllocation } : {}),
    ...(initialAllocationRepair ? { initialAllocationRepair } : {}),
    returnUrl: nullable(v.returnUrl, httpsUrl),
    allowedOrigins: origins(v.allowedOrigins),
    expiresAt: date(v.expiresAt),
    ownerWalletAddress: nullable(v.ownerWalletAddress, (value) =>
      textValue(value, 50, ADDRESS),
    ),
    feePolicy,
    targetConstituents,
    rebalancingRules,
  };
}
export function parseChallenge(value: unknown): Challenge {
  const v = record(value);
  if (
    Object.keys(v).some(
      (key) =>
        ![
          "schemaVersion",
          "payload",
          "challengeId",
          "message",
          "signingBytes",
          "expiresAt",
        ].includes(key),
    ) ||
    (v.schemaVersion !== undefined && v.schemaVersion !== 2)
  )
    throw new Error("Unsupported signing challenge version or fields.");
  return {
    ...(v.payload === undefined ? {} : { payload: record(v.payload) }),
    challengeId: textValue(v.challengeId, 36, UUID),
    message: textValue(v.message, 16000),
    signingBytes: textValue(v.signingBytes, 32002, /^0x[0-9a-f]+$/i),
    expiresAt: date(v.expiresAt),
  };
}
