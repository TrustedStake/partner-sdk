import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { PendingMultisigOp } from "./types.ts";
import {
  deriveMultisigAddress,
  otherSignatoriesFor,
  getMultisigStorageEntry,
  buildWeightBound,
  createWeightType,
  hydrateCallFromHex,
  getCallDataHex,
  getCallHashHex,
} from "./multisig.ts";
import {
  assertProposalRuntime,
  assertProposalCreationRuntime,
  runtimeIdentity,
  sameTimepoint,
} from "./multisig-recovery.ts";
import {
  parseAuthorizationChallenge,
  resolveAuthorizationProof,
  type AuthorizationRequest,
} from "./multisig-authorization.ts";
import { sameWallet } from "./wallet-identity.ts";
import { parseChainReceipt, type ChainReceipt } from "../chain.ts";
import { boundedJson } from "../transport.ts";

export interface PreparedMultisigAction {
  operation: PendingMultisigOp;
  transaction: SubmittableExtrinsic<"promise">;
  /** Invoke immediately before wallet signing, including from the host's guarded signer. */
  assertCurrent(): Promise<void>;
}
async function identity(
  api: ApiPromise,
  op: PendingMultisigOp,
  signer: string,
) {
  if (
    op.chainId !== api.genesisHash.toHex() ||
    !Number.isSafeInteger(op.threshold) ||
    op.threshold < 2 ||
    op.signatories.length < op.threshold ||
    op.signatories.length > 100 ||
    !op.signatories.some((a) => sameWallet(a, signer))
  )
    throw new Error("Invalid multisig signer or network.");
  const derived = await deriveMultisigAddress(op.signatories, op.threshold, 42);
  if (
    new Set(derived.sorted).size !== derived.sorted.length ||
    !sameWallet(derived.multisigAddress, op.multisigAddress) ||
    !sameWallet(op.managedAccount, op.multisigAddress)
  )
    throw new Error("Multisig account does not match its signers.");
  return otherSignatoriesFor(derived.sorted, signer);
}
/** Build a new reviewed call proposal. This does not broadcast, reserve a deposit or start trades. */
export async function createMultisigProposal(
  api: ApiPromise,
  call: SubmittableExtrinsic<"promise">,
  signatories: string[],
  threshold: number,
  signer: string,
  assertCurrentFlow: () => void,
): Promise<PendingMultisigOp> {
  assertCurrentFlow();
  const genesis = api.genesisHash.toHex(),
    runtime = runtimeIdentity(api);
  const derived = await deriveMultisigAddress(signatories, threshold, 42);
  assertCurrentFlow();
  const now = new Date().toISOString();
  const op: PendingMultisigOp = {
    id: `${genesis}:${derived.multisigAddress}:${getCallHashHex(call)}`,
    chainId: genesis,
    threshold,
    signatories,
    sortedSignatories: derived.sorted,
    multisigAddress: derived.multisigAddress,
    managedAccount: derived.multisigAddress,
    currentSigner: signer,
    callDataHex: getCallDataHex(call),
    callHashHex: getCallHashHex(call),
    runtime,
    operationKind: "other",
    operationLabel: "Reviewed partner transaction",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  await identity(api, op, signer);
  assertCurrentFlow();
  assertProposalRuntime(api, op);
  return op;
}
/** Prepare approval/execution or depositor cancellation using fresh finalized state. No automatic submission. */
export async function prepareMultisigAction(
  api: ApiPromise,
  input: PendingMultisigOp,
  signer: string,
  action: "approve" | "cancel",
  assertCurrentFlow: () => void,
): Promise<PreparedMultisigAction> {
  const op = structuredClone(input);
  assertCurrentFlow();
  if (op.authorizationProof || op.callDataHex === "0x")
    throw new Error("Authorization hashes cannot be executed as proposals.");
  const others = await identity(api, op, signer);
  if (op.timepoint) await assertProposalCreationRuntime(api, op);
  // Cancellation does not decode call bytes and remains available after runtime upgrades.
  if (action === "approve") assertProposalRuntime(api, op);
  const before = await getMultisigStorageEntry(
    api,
    op.multisigAddress,
    op.callHashHex,
  );
  assertCurrentFlow();
  if (
    op.timepoint &&
    (!before || !sameTimepoint(before.timepoint, op.timepoint))
  )
    throw new Error("Proposal changed or disappeared. Verify its receipt.");
  if (
    !before &&
    (op.status !== "draft" || op.extrinsicHash || op.blockHash || op.timepoint)
  )
    throw new Error("Uncertain proposal cannot be resubmitted.");
  let transaction: SubmittableExtrinsic<"promise">;
  if (action === "cancel") {
    if (!before || !sameWallet(before.depositor, signer))
      throw new Error("Only the original depositor can cancel this proposal.");
    transaction = api.tx.multisig.cancelAsMulti(
      op.threshold,
      others,
      before.timepoint,
      op.callHashHex,
    );
  } else {
    const call = hydrateCallFromHex(api, op.callDataHex);
    const weight = createWeightType(
      api,
      await buildWeightBound(api, call, op.multisigAddress),
    );
    const approved =
      before?.approvals.some((a) => sameWallet(a, signer)) ?? false;
    if (approved && before!.approvals.length < op.threshold)
      throw new Error("This signer already approved.");
    transaction =
      before && before.approvals.length + (approved ? 0 : 1) >= op.threshold
        ? api.tx.multisig.asMulti(
            op.threshold,
            others,
            before.timepoint,
            call,
            weight,
          )
        : api.tx.multisig.approveAsMulti(
            op.threshold,
            others,
            before?.timepoint ?? null,
            op.callHashHex,
            weight,
          );
  }
  const reviewedRuntime = JSON.stringify(runtimeIdentity(api));
  const assertCurrent = async () => {
    assertCurrentFlow();
    if (
      op.chainId !== api.genesisHash.toHex() ||
      JSON.stringify(runtimeIdentity(api)) !== reviewedRuntime
    )
      throw new Error("Network or runtime changed. Review again.");
    if (action === "approve") assertProposalRuntime(api, op);
    const current = await getMultisigStorageEntry(
      api,
      op.multisigAddress,
      op.callHashHex,
    );
    assertCurrentFlow();
    if (
      JSON.stringify(current) !== JSON.stringify(before) ||
      op.chainId !== api.genesisHash.toHex() ||
      JSON.stringify(runtimeIdentity(api)) !== reviewedRuntime
    )
      throw new Error("Proposal approvals or runtime changed. Review again.");
  };
  await assertCurrent();
  return { operation: op, transaction, assertCurrent };
}
/** Same-origin authorization transport. It sends no partner key, cookies or logging data. */
export function createAuthorizationTransport(
  fetcher: typeof fetch,
  baseUrl: string,
): AuthorizationRequest {
  if (
    !/^\/[a-zA-Z0-9/_-]+$/.test(baseUrl) ||
    baseUrl.endsWith("/") ||
    baseUrl.includes("..")
  )
    throw new Error("Use a same-origin multisig bridge path.");
  return async (action, body) => {
    if (!["challenge", "resolve", "verify"].includes(action))
      throw new Error("Invalid authorization action.");
    const response = await fetcher(`${baseUrl}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Multisig authorization request failed.");
    return boundedJson(response, 8192);
  };
}
/** Creates a server-bound hash-only deposit approval. Never pass this hash to asMulti. */
export async function createAuthorizationDeposit(
  api: ApiPromise,
  signatories: string[],
  threshold: number,
  signer: string,
  request: AuthorizationRequest,
  assertCurrentFlow: () => void,
): Promise<PreparedMultisigAction> {
  assertCurrentFlow();
  const genesis = api.genesisHash.toHex(),
    runtime = JSON.stringify(runtimeIdentity(api));
  const derived = await deriveMultisigAddress(signatories, threshold, 42);
  assertCurrentFlow();
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 2 ||
    signatories.length < threshold ||
    signatories.length > 100 ||
    new Set(derived.sorted).size !== signatories.length ||
    !derived.sorted.some((a) => sameWallet(a, signer))
  )
    throw new Error("Invalid multisig signers.");
  const raw = (await request("challenge", {
    managedWalletAddress: derived.multisigAddress,
    signerAddress: signer,
    chainId: "finney",
  })) as { success?: unknown; data?: unknown };
  assertCurrentFlow();
  if (
    raw?.success !== true ||
    ((raw.data as { genesisHash?: unknown })?.genesisHash !== undefined &&
      (raw.data as { genesisHash?: unknown }).genesisHash !== genesis)
  )
    throw new Error("Authorization network mismatch.");
  // Current challenge response has no genesisHash. The mandatory resolve below binds it to the network.
  const challenge = parseAuthorizationChallenge(
    raw.data,
    derived.multisigAddress,
    signer,
  );
  const now = new Date().toISOString();
  const op: PendingMultisigOp = {
    id: `membership-auth:${challenge.challengeId}:${signer}`,
    chainId: genesis,
    threshold,
    signatories,
    sortedSignatories: derived.sorted,
    currentSigner: signer,
    multisigAddress: derived.multisigAddress,
    managedAccount: derived.multisigAddress,
    callDataHex: "0x",
    callHashHex: challenge.callHash,
    operationKind: "other",
    operationLabel: "Membership authorization deposit",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    authorizationProof: {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
    },
  };
  const assertCurrent = async () => {
    assertCurrentFlow();
    if (
      genesis !== api.genesisHash.toHex() ||
      runtime !== JSON.stringify(runtimeIdentity(api)) ||
      Date.parse(challenge.expiresAt) <= Date.now()
    )
      throw new Error("Authorization context expired or changed.");
    await resolveAuthorizationProof(op, request);
    if (await getMultisigStorageEntry(api, op.multisigAddress, op.callHashHex))
      throw new Error("Authorization deposit already exists. Resume it.");
    assertCurrentFlow();
    if (
      genesis !== api.genesisHash.toHex() ||
      runtime !== JSON.stringify(runtimeIdentity(api)) ||
      Date.parse(challenge.expiresAt) <= Date.now()
    )
      throw new Error("Authorization context expired or changed.");
  };
  await assertCurrent();
  return {
    operation: op,
    transaction: api.tx.multisig.approveAsMulti(
      threshold,
      otherSignatoriesFor(derived.sorted, signer),
      null,
      challenge.callHash,
      createWeightType(api, { refTime: "1000000000", proofSize: "1000000" }),
    ),
    assertCurrent,
  };
}
/** Resume verification without placing a second deposit. Persists public recovery evidence through save before HTTP verification. */
export async function verifyAuthorizationDeposit(
  api: ApiPromise,
  input: PendingMultisigOp,
  signer: string,
  request: AuthorizationRequest,
  assertCurrentFlow: () => void,
  save: (op: PendingMultisigOp) => void,
) {
  const op = structuredClone(input);
  assertCurrentFlow();
  await identity(api, op, signer);
  if (!sameWallet(op.currentSigner, signer))
    throw new Error("Connect the original authorization signer.");
  await resolveAuthorizationProof(op, request);
  const entry = await getMultisigStorageEntry(
    api,
    op.multisigAddress,
    op.callHashHex,
  );
  assertCurrentFlow();
  if (
    !entry ||
    !sameWallet(entry.depositor, signer) ||
    !entry.approvals.some((a) => sameWallet(a, signer)) ||
    (op.timepoint && !sameTimepoint(op.timepoint, entry.timepoint))
  )
    throw new Error(
      "Authorization deposit is not confirmed. Do not submit a replacement.",
    );
  Object.assign(op, entry, { status: "pending_approvals" });
  save(op);
  const raw = (await request("verify", {
    challengeId: op.authorizationProof!.challengeId,
    managedWalletAddress: op.managedAccount,
    signerAddress: signer,
    chainId: "finney",
  })) as { success?: unknown; data?: Record<string, unknown> };
  assertCurrentFlow();
  const data = raw?.data;
  if (
    raw?.success !== true ||
    !data ||
    !sameWallet(String(data.managedWalletAddress), op.managedAccount) ||
    !sameWallet(String(data.signerAddress), signer) ||
    data.chainId !== "finney" ||
    !Number.isFinite(Date.parse(String(data.verifiedAt))) ||
    Date.parse(String(data.expiresAt)) <= Date.now() ||
    !Number.isFinite(Date.parse(String(data.expiresAt)))
  )
    throw new Error(
      "Authorization was not confirmed. Resume this proof or reclaim its deposit.",
    );
  return {
    operation: op,
    verifiedAt: String(data.verifiedAt),
    expiresAt: String(data.expiresAt),
  };
}
export async function prepareAuthorizationCancellation(
  api: ApiPromise,
  input: PendingMultisigOp,
  signer: string,
  request: AuthorizationRequest,
  assertCurrentFlow: () => void,
): Promise<PreparedMultisigAction> {
  const op = structuredClone(input);
  assertCurrentFlow();
  const others = await identity(api, op, signer);
  if (!sameWallet(op.currentSigner, signer))
    throw new Error("Connect the original authorization signer.");
  const assertCurrent = async () => {
    assertCurrentFlow();
    await resolveAuthorizationProof(op, request);
    const entry = await getMultisigStorageEntry(
      api,
      op.multisigAddress,
      op.callHashHex,
    );
    assertCurrentFlow();
    if (
      api.genesisHash.toHex() !== op.chainId ||
      !entry ||
      !sameWallet(entry.depositor, signer) ||
      !sameTimepoint(entry.timepoint, op.timepoint)
    )
      throw new Error(
        "Authorization deposit changed or disappeared. Verify its receipt.",
      );
  };
  await assertCurrent();
  return {
    operation: op,
    transaction: api.tx.multisig.cancelAsMulti(
      op.threshold,
      others,
      op.timepoint,
      op.callHashHex,
    ),
    assertCurrent,
  };
}

const submitted = new WeakSet<PreparedMultisigAction>();
/** Journal before invoking the host's guarded finalized submitter. An exception never permits an automatic retry. */
export async function submitPreparedMultisigAction(
  prepared: PreparedMultisigAction,
  submit: (
    transaction: SubmittableExtrinsic<"promise">,
    assertCurrent: () => Promise<void>,
  ) => Promise<ChainReceipt>,
  save: (operation: PendingMultisigOp) => void,
): Promise<PendingMultisigOp> {
  if (submitted.has(prepared))
    throw new Error(
      "This action was already submitted. Reconcile before another action.",
    );
  submitted.add(prepared);
  await prepared.assertCurrent();
  const pending = {
    ...structuredClone(prepared.operation),
    status: "needs_review" as const,
    updatedAt: new Date().toISOString(),
  };
  save(pending);
  const receipt = parseChainReceipt(
    await submit(prepared.transaction, prepared.assertCurrent),
  );
  const recorded = {
    ...pending,
    extrinsicHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
  };
  save(recorded);
  // Receipt presence is not execution success. Inspect finalized events/storage next.
  return recorded;
}
