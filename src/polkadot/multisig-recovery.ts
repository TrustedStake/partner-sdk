import type { EventRecord } from "@polkadot/types/interfaces";
import { decodeBatchEvents } from "./receipt-events.ts";
import type { ApiPromise } from "@polkadot/api";
import {
  blake2AsHex,
  createKeyMulti,
  cryptoWaitReady,
  decodeAddress,
  encodeAddress,
  sortAddresses,
} from "@polkadot/util-crypto";
import type { PendingMultisigOp, MultisigTimepoint } from "./types.ts";
import { sameWallet } from "./wallet-identity.ts";

const HASH = /^0x[0-9a-f]{64}$/i;
export const MAX_PROPOSAL_BYTES = 160_000;
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function record(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("Invalid proposal document.");
  return v;
}
function exact(v: Record<string, unknown>, keys: string[]) {
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw new Error("Unexpected proposal fields.");
}
function address(v: unknown): string {
  if (typeof v !== "string" || v.length > 64 || decodeAddress(v).length !== 32)
    throw new Error("Invalid proposal account.");
  return encodeAddress(decodeAddress(v), 42);
}
function hash(v: unknown): string {
  if (typeof v !== "string" || !HASH.test(v))
    throw new Error("Invalid proposal hash.");
  return v.toLowerCase();
}
export function sameTimepoint(
  a?: MultisigTimepoint | null,
  b?: MultisigTimepoint | null,
) {
  return !!a && !!b && a.height === b.height && a.index === b.index;
}
export function runtimeIdentity(api: ApiPromise) {
  return {
    specVersion: api.runtimeVersion.specVersion.toNumber(),
    transactionVersion: api.runtimeVersion.transactionVersion.toNumber(),
  };
}
export function assertProposalRuntime(api: ApiPromise, op: PendingMultisigOp) {
  const current = runtimeIdentity(api);
  if (op.chainId !== api.genesisHash.toHex())
    throw new Error("This proposal belongs to another network.");
  if (
    !op.runtime ||
    op.runtime.specVersion !== current.specVersion ||
    op.runtime.transactionVersion !== current.transactionVersion
  ) {
    throw new Error(
      "The network runtime changed or this proposal predates runtime checks. Cancel the old proposal, then review and create a new one.",
    );
  }
  if (blake2AsHex(op.callDataHex, 256) !== op.callHashHex.toLowerCase())
    throw new Error("Proposal call data does not match its hash.");
}

/** A file transports public proposal data, never signing authority or a trusted outcome. */
export function exportMultisigProposal(op: PendingMultisigOp): string {
  if (!op.runtime || !op.timepoint || !HASH.test(op.callHashHex))
    throw new Error(
      "Refresh the proposal before sharing. A runtime-checked on-chain proposal is required.",
    );
  return JSON.stringify(
    {
      schema: "trustedstake-multisig-v1",
      genesisHash: op.chainId,
      multisigAddress: op.multisigAddress,
      threshold: op.threshold,
      signatories: op.signatories,
      callDataHex: op.callDataHex,
      callHashHex: op.callHashHex,
      timepoint: op.timepoint,
      runtime: op.runtime,
      ...(op.blockHash && op.extrinsicHash
        ? { receipt: { blockHash: op.blockHash, txHash: op.extrinsicHash } }
        : {}),
    },
    null,
    2,
  );
}
export async function importMultisigProposal(
  api: ApiPromise,
  text: string,
  signer: string,
): Promise<PendingMultisigOp> {
  if (text.length > MAX_PROPOSAL_BYTES)
    throw new Error("Proposal file is too large.");
  const value = record(JSON.parse(text));
  exact(value, [
    "schema",
    "genesisHash",
    "multisigAddress",
    "threshold",
    "signatories",
    "callDataHex",
    "callHashHex",
    "timepoint",
    "runtime",
    "receipt",
  ]);
  if (
    value.schema !== "trustedstake-multisig-v1" ||
    !integer(value.threshold) ||
    value.threshold < 2 ||
    !Array.isArray(value.signatories) ||
    value.signatories.length > 100 ||
    value.signatories.length < value.threshold
  )
    throw new Error("Invalid multisig threshold or signers.");
  await cryptoWaitReady();
  const signatories = value.signatories.map(address);
  if (
    new Set(signatories).size !== signatories.length ||
    !signatories.some((s) => sameWallet(s, signer))
  )
    throw new Error(
      "Connect a signer included in this proposal. Signers must be unique.",
    );
  const sorted = sortAddresses(signatories, 42);
  const multisigAddress = encodeAddress(
    createKeyMulti(sorted, value.threshold),
    42,
  );
  if (!sameWallet(multisigAddress, address(value.multisigAddress)))
    throw new Error(
      "Proposal account does not match its signers and threshold.",
    );
  const point = record(value.timepoint),
    runtime = record(value.runtime);
  exact(point, ["height", "index"]);
  exact(runtime, ["specVersion", "transactionVersion"]);
  if (
    !integer(point.height) ||
    !integer(point.index) ||
    !integer(runtime.specVersion) ||
    !integer(runtime.transactionVersion)
  )
    throw new Error("Invalid proposal runtime or timepoint.");
  if (
    typeof value.callDataHex !== "string" ||
    value.callDataHex.length > 131_074 ||
    !/^0x(?:[0-9a-f]{2}){2,}$/i.test(value.callDataHex)
  )
    throw new Error("Invalid proposal call data.");
  const op: PendingMultisigOp = {
    id: `${hash(value.genesisHash)}:${multisigAddress}:${hash(value.callHashHex)}`,
    chainId: hash(value.genesisHash),
    multisigAddress,
    managedAccount: multisigAddress,
    threshold: value.threshold,
    signatories,
    sortedSignatories: sorted,
    callDataHex: value.callDataHex.toLowerCase(),
    callHashHex: hash(value.callHashHex),
    timepoint: { height: point.height, index: point.index },
    runtime: {
      specVersion: runtime.specVersion,
      transactionVersion: runtime.transactionVersion,
    },
    operationKind: "other",
    operationLabel: "Shared transaction",
    status: "needs_review",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (
    op.chainId !== api.genesisHash.toHex() ||
    blake2AsHex(op.callDataHex, 256) !== op.callHashHex
  )
    throw new Error("Proposal network or call hash does not match.");
  await assertProposalCreationRuntime(api, op);
  if (value.receipt !== undefined) {
    const receipt = record(value.receipt);
    exact(receipt, ["blockHash", "txHash"]);
    op.blockHash = hash(receipt.blockHash);
    op.extrinsicHash = hash(receipt.txHash);
  }
  return op;
}

/** Local browser data and shared files cannot relabel pre-upgrade call bytes. */
export async function assertProposalCreationRuntime(
  api: ApiPromise,
  op: PendingMultisigOp,
) {
  const point = op.timepoint,
    runtime = op.runtime;
  if (!point || !runtime || !integer(point.height) || !integer(point.index))
    throw new Error("Proposal creation evidence is missing.");
  const head = await api.rpc.chain.getFinalizedHead();
  const header = await api.rpc.chain.getHeader(head);
  if (point.height > header.number.toNumber())
    throw new Error("Proposal has not finalized yet.");
  const creationHash = await api.rpc.chain.getBlockHash(point.height);
  const actualRuntime = await api.rpc.state.getRuntimeVersion(creationHash);
  if (
    actualRuntime.specVersion.toNumber() !== runtime.specVersion ||
    actualRuntime.transactionVersion.toNumber() !== runtime.transactionVersion
  )
    throw new Error("Proposal runtime does not match its creation block.");
}

/** Only exact canonical finalized events can settle a vanished proposal. */
export async function verifyMultisigReceipt(
  api: ApiPromise,
  op: PendingMultisigOp,
): Promise<"executed" | "cancelled" | "failed" | null> {
  if (
    !op.blockHash ||
    !op.extrinsicHash ||
    !op.timepoint ||
    !HASH.test(op.blockHash) ||
    !HASH.test(op.extrinsicHash)
  )
    return null;
  if (op.chainId !== api.genesisHash.toHex())
    throw new Error("Receipt belongs to another network.");
  const head = await api.rpc.chain.getFinalizedHead();
  const [finalized, header] = await Promise.all([
    api.rpc.chain.getHeader(head),
    api.rpc.chain.getHeader(op.blockHash),
  ]);
  if (
    header.number.toBigInt() > finalized.number.toBigInt() ||
    (await api.rpc.chain.getBlockHash(header.number.toString())).toHex() !==
      op.blockHash
  )
    throw new Error("Receipt block is not finalized on this chain.");
  const [block, events] = await Promise.all([
    api.rpc.chain.getBlock(op.blockHash),
    api.query.system.events.at(op.blockHash),
  ]);
  const index = block.block.extrinsics.findIndex(
    (tx) => tx.hash.toHex() === op.extrinsicHash,
  );
  if (index < 0)
    throw new Error("Transaction was not found in the receipt block.");
  for (const { phase, event } of events as unknown as EventRecord[]) {
    if (
      !phase.isApplyExtrinsic ||
      phase.asApplyExtrinsic.toNumber() !== index ||
      event.section !== "multisig" ||
      !["MultisigExecuted", "MultisigCancelled"].includes(event.method)
    )
      continue;
    const data = event.data;
    const point = data[1].toJSON() as MultisigTimepoint;
    if (
      !sameTimepoint(point, op.timepoint) ||
      !sameWallet(data[2].toString(), op.multisigAddress) ||
      data[3].toString().toLowerCase() !== op.callHashHex.toLowerCase()
    )
      continue;
    if (event.method === "MultisigCancelled") return "cancelled";
    const result = data[4] as unknown as { isOk?: boolean; isErr?: boolean };
    if (result.isOk === true && result.isErr === false) {
      const scoped = (events as unknown as EventRecord[]).filter(
        (e) =>
          e.phase.isApplyExtrinsic &&
          e.phase.asApplyExtrinsic.toNumber() === index,
      );
      return decodeBatchEvents(scoped).success ? "executed" : "failed";
    }
    if (result.isErr === true && result.isOk === false) return "failed";
    throw new Error("Unrecognized multisig execution result.");
  }
  return null;
}
