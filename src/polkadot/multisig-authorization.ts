import type { ApiPromise } from "@polkadot/api";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import type { PendingMultisigOp } from "./types.ts";
import { deriveMultisigAddress, getMultisigStorageEntry } from "./multisig.ts";
import { sameWallet } from "./wallet-identity.ts";
export type AuthorizationRequest = (
  action: "challenge" | "resolve" | "verify",
  body: Record<string, unknown>,
) => Promise<unknown>;
import { sameTimepoint, verifyMultisigReceipt } from "./multisig-recovery.ts";

const HASH = /^0x[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new Error("Invalid authorization recovery file.");
  return value as Record<string, unknown>;
}
function address(value: unknown): string {
  if (typeof value !== "string" || value.length > 64)
    throw new Error("Invalid recovery account.");
  const key = decodeAddress(value);
  if (key.length !== 32) throw new Error("Invalid recovery account.");
  return encodeAddress(key, 42);
}
export function parseAuthorizationChallenge(
  raw: unknown,
  managed: string,
  signer: string,
  allowExpired = false,
) {
  const data = object(raw, [
    "genesisHash",
    "challengeId",
    "challengeCallHash",
    "managedWalletAddress",
    "signerAddress",
    "chainId",
    "expiresAt",
    "approveAsMultiTemplate",
  ]);
  if (
    typeof data.challengeId !== "string" ||
    !UUID.test(data.challengeId) ||
    typeof data.challengeCallHash !== "string" ||
    !HASH.test(data.challengeCallHash) ||
    data.chainId !== "finney" ||
    !sameWallet(address(data.managedWalletAddress), managed) ||
    !sameWallet(address(data.signerAddress), signer) ||
    typeof data.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(data.expiresAt)) ||
    (!allowExpired && Date.parse(data.expiresAt) <= Date.now()) ||
    Date.parse(data.expiresAt) > Date.now() + 11 * 60_000
  )
    throw new Error(
      "Authorization challenge did not match this wallet and network.",
    );
  return {
    challengeId: data.challengeId,
    callHash: data.challengeCallHash,
    expiresAt: data.expiresAt,
  };
}
/** Resolve the server-issued hash before calling an entry an authorization proof. */
export async function resolveAuthorizationProof(
  op: Pick<
    PendingMultisigOp,
    | "authorizationProof"
    | "callHashHex"
    | "managedAccount"
    | "currentSigner"
    | "chainId"
  >,
  request: AuthorizationRequest,
) {
  if (
    !op.authorizationProof ||
    !UUID.test(op.authorizationProof.challengeId) ||
    !op.currentSigner
  )
    throw new Error("Authorization challenge is unavailable.");
  const raw = object(
    await request("resolve", {
      challengeId: op.authorizationProof.challengeId,
      managedWalletAddress: op.managedAccount,
      signerAddress: op.currentSigner,
      chainId: "finney",
    }),
    ["success", "data", "message"],
  );
  if (raw.success !== true)
    throw new Error("Could not resolve the original authorization proof.");
  if (
    !raw.data ||
    typeof raw.data !== "object" ||
    (raw.data as Record<string, unknown>).genesisHash !== op.chainId
  )
    throw new Error("Authorization proof belongs to another network.");
  const proof = parseAuthorizationChallenge(
    raw.data,
    op.managedAccount,
    op.currentSigner,
    true,
  );
  if (
    proof.challengeId !== op.authorizationProof.challengeId ||
    proof.callHash !== op.callHashHex
  )
    throw new Error(
      "This hash is not the server-issued authorization proof. No cancellation is allowed.",
    );
  return proof;
}

/** Hash-only authorization evidence is never accepted by the executable proposal importer. */
export function exportAuthorizationProof(op: PendingMultisigOp): string {
  if (!op.authorizationProof || !op.timepoint || !op.depositor)
    throw new Error(
      "Refresh the authorization deposit before saving recovery details.",
    );
  return JSON.stringify(
    {
      schema: "trustedstake-authorization-proof-v1",
      genesisHash: op.chainId,
      multisigAddress: op.multisigAddress,
      signerAddress: op.currentSigner,
      signatories: op.signatories,
      threshold: op.threshold,
      callHash: op.callHashHex,
      timepoint: op.timepoint,
      depositor: op.depositor,
      ...op.authorizationProof,
      ...(op.blockHash && op.extrinsicHash
        ? { receipt: { blockHash: op.blockHash, txHash: op.extrinsicHash } }
        : {}),
    },
    null,
    2,
  );
}
export async function importAuthorizationProof(
  api: ApiPromise,
  raw: string,
  signer: string,
  request: AuthorizationRequest,
): Promise<PendingMultisigOp> {
  if (raw.length > 16_384)
    throw new Error("Authorization recovery file is too large.");
  const data = object(JSON.parse(raw), [
    "schema",
    "genesisHash",
    "multisigAddress",
    "signerAddress",
    "signatories",
    "threshold",
    "callHash",
    "timepoint",
    "depositor",
    "challengeId",
    "expiresAt",
    "receipt",
  ]);
  if (
    data.schema !== "trustedstake-authorization-proof-v1" ||
    typeof data.genesisHash !== "string" ||
    !HASH.test(data.genesisHash) ||
    data.genesisHash !== api.genesisHash.toHex() ||
    typeof data.callHash !== "string" ||
    !HASH.test(data.callHash) ||
    typeof data.challengeId !== "string" ||
    !UUID.test(data.challengeId) ||
    typeof data.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(data.expiresAt)) ||
    !Number.isSafeInteger(data.threshold) ||
    Number(data.threshold) < 2 ||
    !Array.isArray(data.signatories) ||
    data.signatories.length < Number(data.threshold) ||
    data.signatories.length > 100
  )
    throw new Error("Invalid authorization recovery context.");
  const signatories = data.signatories.map(address);
  const originalSigner = address(data.signerAddress),
    depositor = address(data.depositor);
  if (
    new Set(signatories).size !== signatories.length ||
    !sameWallet(originalSigner, signer) ||
    !sameWallet(depositor, signer) ||
    !signatories.some((a) => sameWallet(a, signer))
  )
    throw new Error(
      "Connect the signer who created this authorization deposit.",
    );
  const point = object(data.timepoint, ["height", "index"]);
  if (
    !Number.isSafeInteger(point.height) ||
    Number(point.height) < 0 ||
    Number(point.height) > 0xffffffff ||
    !Number.isSafeInteger(point.index) ||
    Number(point.index) < 0 ||
    Number(point.index) > 0xffffffff
  )
    throw new Error("Invalid authorization timepoint.");
  const timepoint = {
    height: Number(point.height),
    index: Number(point.index),
  };
  const derived = await deriveMultisigAddress(
    signatories,
    Number(data.threshold),
    42,
  );
  if (!sameWallet(derived.multisigAddress, address(data.multisigAddress)))
    throw new Error("Authorization account does not match its signers.");
  const resolved = await resolveAuthorizationProof(
    {
      chainId: data.genesisHash,
      authorizationProof: {
        challengeId: data.challengeId,
        expiresAt: data.expiresAt,
      },
      callHashHex: data.callHash,
      managedAccount: derived.multisigAddress,
      currentSigner: originalSigner,
    },
    request,
  );
  const entry = await getMultisigStorageEntry(
    api,
    derived.multisigAddress,
    data.callHash,
  );
  if (
    entry &&
    (!sameTimepoint(entry.timepoint, timepoint) ||
      !sameWallet(entry.depositor, depositor))
  )
    throw new Error(
      "Authorization deposit no longer matches this recovery file.",
    );
  let receipt: { blockHash: string; extrinsicHash: string } | undefined;
  if (data.receipt !== undefined) {
    const value = object(data.receipt, ["blockHash", "txHash"]);
    if (
      typeof value.blockHash !== "string" ||
      !HASH.test(value.blockHash) ||
      typeof value.txHash !== "string" ||
      !HASH.test(value.txHash)
    )
      throw new Error("Invalid cancellation receipt.");
    receipt = { blockHash: value.blockHash, extrinsicHash: value.txHash };
  }
  const now = new Date().toISOString();
  const op: PendingMultisigOp = {
    id: `membership-auth:${data.challengeId}:${originalSigner}`,
    chainId: data.genesisHash,
    multisigAddress: derived.multisigAddress,
    managedAccount: derived.multisigAddress,
    currentSigner: originalSigner,
    signatories,
    sortedSignatories: derived.sorted,
    threshold: Number(data.threshold),
    operationKind: "other",
    operationLabel: "Membership authorization deposit",
    callDataHex: "0x",
    callHashHex: data.callHash,
    timepoint,
    depositor,
    approvals: entry?.approvals,
    status: "needs_review",
    createdAt: now,
    updatedAt: now,
    ...receipt,
    authorizationProof: {
      challengeId: data.challengeId,
      expiresAt: resolved.expiresAt,
    },
    error: entry
      ? undefined
      : "Deposit not found. Verify the cancellation receipt; absence alone does not prove a refund.",
  };
  if (
    !entry &&
    receipt &&
    (await verifyMultisigReceipt(api, op)) === "cancelled"
  ) {
    op.status = "cancelled";
    op.error = undefined;
  }
  return op;
}
