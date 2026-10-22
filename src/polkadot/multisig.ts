import { verifyMultisigReceipt, sameTimepoint } from "./multisig-recovery.ts";
import { sameWallet } from "./wallet-identity.ts";
import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import { u8aToHex } from "@polkadot/util";
import {
  createKeyMulti,
  cryptoWaitReady,
  encodeAddress,
  decodeAddress,
  sortAddresses,
} from "@polkadot/util-crypto";
import type {
  MultisigConfig,
  MultisigRuntimeCapabilities,
  MultisigSubmissionOutcome,
  MultisigTimepoint,
  MultisigWeight,
  PendingMultisigOp,
  PendingMultisigOpStatus,
} from "./types.ts";

type ProxyRecord = {
  delegate: string;
  proxyType: string;
  delay: number;
};

type QueryMultisigEntry = {
  when: {
    height: { toNumber: () => number };
    index: { toNumber: () => number };
  };
  approvals: { toJSON: () => string[] };
  depositor: { toString: () => string };
};

export async function deriveMultisigAddress(
  addresses: string[],
  threshold: number,
  ss58Prefix: number,
) {
  await cryptoWaitReady();
  const sorted = sortAddresses(addresses, ss58Prefix);
  const multiPub = createKeyMulti(sorted, threshold);
  const multisigAddress = encodeAddress(multiPub, ss58Prefix);
  return { sorted, multisigAddress };
}

export function otherSignatoriesFor(sorted: string[], signer: string) {
  return sorted.filter((address) => !sameWallet(address, signer));
}

export function defaultMultisigConfig(): MultisigConfig {
  return {
    enabled: false,
    threshold: 2,
    signatories: [],
    managedAccount: "",
    proxyType: "Staking",
  };
}

export function emptyCapabilities(): MultisigRuntimeCapabilities {
  return {
    isReady: false,
    chainId: null,
    chainName: null,
    ss58Prefix: 42,
    hasMultisig: false,
    hasProxy: false,
    hasProxyAddRemove: false,
    hasMultisigStorage: false,
    hasAsMultiThreshold1: false,
    maxSignatories: null,
    depositBase: null,
    depositFactor: null,
  };
}

export function normalizeSignatories(signatories: string[]) {
  return signatories
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function isMultisigConfigReady(config: MultisigConfig) {
  const signatories = normalizeSignatories(config.signatories);
  return (
    signatories.length > 0 &&
    signatories.length <= 100 &&
    Number.isSafeInteger(config.threshold) &&
    config.threshold > 0 &&
    config.threshold <= signatories.length
  );
}

export async function getMultisigRuntimeCapabilities(
  api: ApiPromise | null,
): Promise<MultisigRuntimeCapabilities> {
  if (!api) {
    return emptyCapabilities();
  }

  const chainName = (await api.rpc.system.chain()).toString();

  return {
    isReady: true,
    chainId: api.genesisHash.toHex(),
    chainName,
    ss58Prefix: api.registry.chainSS58 ?? 42,
    hasMultisig: Boolean(api.tx.multisig && api.query.multisig),
    hasProxy: Boolean(api.tx.proxy && api.query.proxy),
    hasProxyAddRemove: Boolean(
      api.tx.proxy?.addProxy && api.tx.proxy?.removeProxy,
    ),
    hasMultisigStorage: Boolean(api.query.multisig?.multisigs),
    hasAsMultiThreshold1: Boolean(api.tx.multisig?.asMultiThreshold1),
    maxSignatories: api.consts.multisig?.maxSignatories
      ? Number(api.consts.multisig.maxSignatories.toString())
      : null,
    depositBase: api.consts.multisig?.depositBase?.toString?.() ?? null,
    depositFactor: api.consts.multisig?.depositFactor?.toString?.() ?? null,
  };
}

export async function buildWeightBound(
  api: ApiPromise,
  call: SubmittableExtrinsic<"promise">,
  address: string,
): Promise<MultisigWeight> {
  const paymentInfo = await call.paymentInfo(address);
  const weightJson = paymentInfo.weight.toJSON() as {
    refTime?: string | number;
    proofSize?: string | number;
  };

  return {
    refTime: String(weightJson.refTime ?? 0),
    proofSize: String(weightJson.proofSize ?? 0),
  };
}

export function createWeightType(api: ApiPromise, weight: MultisigWeight) {
  return api.registry.createType("SpWeightsWeightV2Weight", {
    refTime: weight.refTime,
    proofSize: weight.proofSize,
  });
}

export async function buildProxyRelationshipCall(
  api: ApiPromise,
  params: {
    kind: "add" | "remove";
    delegate: string;
    proxyType?: string;
    delay?: number;
  },
) {
  const { kind, delegate, proxyType = "Staking", delay = 0 } = params;
  if (!api.tx.proxy?.addProxy || !api.tx.proxy?.removeProxy) {
    throw new Error("Proxy pallet is not available on the connected chain.");
  }

  return kind === "add"
    ? api.tx.proxy.addProxy(delegate, proxyType, delay)
    : api.tx.proxy.removeProxy(delegate, proxyType, delay);
}

export function buildPendingOpId(op: {
  chainId: string;
  multisigAddress: string;
  callHashHex: string;
}) {
  return `${op.chainId}:${op.multisigAddress}:${op.callHashHex}`;
}

export function getCallDataHex(call: SubmittableExtrinsic<"promise">) {
  return call.method.toHex();
}

export function getCallHashHex(call: SubmittableExtrinsic<"promise">) {
  return call.method.hash.toHex();
}

export function decodeDispatchError(api: ApiPromise, error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "isModule" in error &&
    (error as { isModule?: boolean }).isModule
  ) {
    const decoded = api.registry.findMetaError(
      (error as unknown as { asModule: unknown }).asModule as never,
    );
    return `${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function getTxHash(result: { txHash?: { toHex?: () => string } }) {
  return result.txHash?.toHex?.();
}

export function getTimepointFromEntry(
  entry: QueryMultisigEntry,
): MultisigTimepoint {
  return {
    height: entry.when.height.toNumber(),
    index: entry.when.index.toNumber(),
  };
}

export async function getMultisigStorageEntry(
  api: ApiPromise,
  multisigAddress: string,
  callHashHex: string,
) {
  const finalized = await api.at(await api.rpc.chain.getFinalizedHead());
  const query = (await finalized.query.multisig.multisigs(
    multisigAddress,
    callHashHex,
  )) as any;
  if (!query) throw new Error("Multisig storage is unavailable.");
  if (query.isNone) {
    return null;
  }

  const entry = query.unwrap() as QueryMultisigEntry;
  const approvals = entry.approvals.toJSON();
  const timepoint = getTimepointFromEntry(entry);
  const depositor = entry.depositor.toString();
  if (
    !Number.isSafeInteger(timepoint.height) ||
    timepoint.height < 0 ||
    !Number.isSafeInteger(timepoint.index) ||
    timepoint.index < 0 ||
    !Array.isArray(approvals) ||
    approvals.length > 100 ||
    approvals.some(
      (value) =>
        typeof value !== "string" ||
        value.length > 64 ||
        decodeAddress(value).length !== 32,
    ) ||
    new Set(approvals.map((value) => encodeAddress(decodeAddress(value), 42)))
      .size !== approvals.length ||
    decodeAddress(depositor).length !== 32
  )
    throw new Error("Invalid on-chain multisig state.");
  return { timepoint, approvals, depositor };
}

export async function hasProxyRelationship(
  api: ApiPromise,
  address: string,
  delegate: string | null | undefined,
  proxyType: string | null | undefined,
) {
  if (!delegate || !proxyType || !api.query.proxy?.proxies) {
    return false;
  }

  const result = await api.query.proxy.proxies(address);
  if (result.isEmpty) {
    return false;
  }

  const [records] = result.toJSON() as [ProxyRecord[], unknown];
  return (records ?? []).some(
    (record) => record.delegate === delegate && record.proxyType === proxyType,
  );
}

export async function inferPendingOpStatus(
  api: ApiPromise,
  op: PendingMultisigOp,
  observedEntry?: Awaited<ReturnType<typeof getMultisigStorageEntry>>,
): Promise<{
  status: PendingMultisigOpStatus;
  timepoint: MultisigTimepoint | null;
}> {
  const storageEntry =
    observedEntry === undefined
      ? await getMultisigStorageEntry(api, op.multisigAddress, op.callHashHex)
      : observedEntry;

  if (storageEntry) {
    if (op.timepoint && !sameTimepoint(op.timepoint, storageEntry.timepoint))
      return { status: "needs_review", timepoint: op.timepoint };
    return {
      status:
        !op.authorizationProof &&
        storageEntry.approvals.length >= op.threshold - 1
          ? "ready_to_execute"
          : "pending_approvals",
      timepoint: storageEntry.timepoint,
    };
  }
  const outcome = await verifyMultisigReceipt(api, op);
  return { status: outcome ?? "needs_review", timepoint: op.timepoint ?? null };
}

export function buildPendingOpRecord(params: {
  chainId: string;
  threshold: number;
  signatories: string[];
  sortedSignatories: string[];
  currentSigner: string;
  multisigAddress: string;
  managedAccount: string;
  operationKind: PendingMultisigOp["operationKind"];
  operationLabel: string;
  call: SubmittableExtrinsic<"promise">;
  maxWeight: MultisigWeight;
  proxyDelegate?: string | null;
  proxyType?: string | null;
  existing?: PendingMultisigOp | null;
}): PendingMultisigOp {
  const {
    chainId,
    threshold,
    signatories,
    sortedSignatories,
    currentSigner,
    multisigAddress,
    managedAccount,
    operationKind,
    operationLabel,
    call,
    maxWeight,
    proxyDelegate,
    proxyType,
    existing,
  } = params;

  const now = new Date().toISOString();
  const callHashHex = existing?.callHashHex ?? getCallHashHex(call);
  const id = existing?.id
    ? existing.id
    : buildPendingOpId({ chainId, multisigAddress, callHashHex });

  return {
    id,
    chainId,
    threshold,
    signatories,
    sortedSignatories,
    currentSigner,
    otherSignatories: otherSignatoriesFor(sortedSignatories, currentSigner),
    multisigAddress,
    managedAccount,
    proxyDelegate: proxyDelegate ?? existing?.proxyDelegate ?? null,
    proxyType: proxyType ?? existing?.proxyType ?? null,
    operationKind,
    operationLabel,
    callDataHex: existing?.callDataHex ?? getCallDataHex(call),
    callHashHex,
    timepoint: existing?.timepoint ?? null,
    maxWeight,
    status: existing?.status ?? "draft",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    extrinsicHash: existing?.extrinsicHash,
    blockHash: existing?.blockHash,
    runtime: existing?.runtime,
    error: existing?.error,
  };
}

export function describeCall(call: SubmittableExtrinsic<"promise">) {
  const args = call.method.args.map((arg) => {
    try {
      return arg.toHuman();
    } catch {
      return arg.toString();
    }
  });

  return {
    section: call.method.section,
    method: call.method.method,
    args,
  };
}

export function hydrateCallFromHex(
  api: ApiPromise,
  callDataHex: string,
): SubmittableExtrinsic<"promise"> {
  const call = api.registry.createType("Call", callDataHex);
  return api.tx(call) as SubmittableExtrinsic<"promise">;
}

export function getCallHashFromHex(api: ApiPromise, callDataHex: string) {
  const call = api.registry.createType("Call", callDataHex);
  return u8aToHex(call.hash.toU8a());
}

export function getMultisigOutcomeMessage(
  outcome: MultisigSubmissionOutcome,
  executedMessage: string,
  pendingMessage = "Approval recorded. Share the proposal file with the remaining signers.",
) {
  if (isMultisigExecuted(outcome)) return executedMessage;
  if (outcome.op.status === "needs_review")
    return "Transaction outcome is unconfirmed. Verify its finalized receipt before continuing.";
  if (outcome.op.status === "failed")
    return "The multisig transaction failed. Review its receipt before creating another proposal; some calls may have completed.";
  if (outcome.op.status === "cancelled")
    return "The multisig proposal was cancelled.";
  return pendingMessage;
}

export function isMultisigExecuted(outcome: MultisigSubmissionOutcome) {
  return outcome.op.status === "executed";
}
