import type { EventRecord } from "@polkadot/types/interfaces";
import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import {
  permissionPlan,
  parseChainReceipt,
  type ChainAdapter,
  type ChainReceipt,
} from "../chain.ts";
import { sameWallet } from "./wallet-identity.ts";
import { decodeBatchEvents } from "./receipt-events.ts";
import { runtimeIdentity } from "./multisig-recovery.ts";
const hash = /^0x[0-9a-f]{64}$/i;
const address = (input: string) => {
  const key = decodeAddress(input);
  if (key.length !== 32) throw new Error("Invalid wallet");
  return encodeAddress(key, 42);
};
const number = (input: unknown) => {
  const n = Number(String(input));
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("Invalid chain number");
  return n;
};
/** Concrete finalized permission adapter. The host supplies its guarded wallet/multisig submitter. */
export function createPolkadotChainAdapter(
  api: ApiPromise,
  submit: (
    tx: SubmittableExtrinsic<"promise">,
    assertCurrent: () => Promise<void>,
  ) => Promise<ChainReceipt>,
): ChainAdapter {
  const finalizedBlock = async (receipt?: ChainReceipt) => {
    const head = await api.rpc.chain.getFinalizedHead(),
      tip = await api.rpc.chain.getHeader(head);
    const blockHash = receipt?.blockHash ?? head.toHex();
    if (!hash.test(blockHash)) throw new Error("Invalid finalized block");
    const header = await api.rpc.chain.getHeader(blockHash),
      height = number(header.number);
    if (
      height > number(tip.number) ||
      (await api.rpc.chain.getBlockHash(height)).toHex() !== blockHash
    )
      throw new Error("Receipt is not canonical and finalized");
    return { blockHash, height };
  };
  const read: ChainAdapter["readPermissions"] = async (
    context,
    wallet,
    receipt,
  ) => {
    wallet.assertCurrentFlow();
    if (
      api.genesisHash.toHex() !== wallet.genesisHash ||
      context.genesisHash !== wallet.genesisHash
    )
      throw new Error("Permission network changed");
    const block = await finalizedBlock(receipt),
      at = await api.at(block.blockHash);
    const owner = address(wallet.managedWalletAddress),
      delegate = address(context.proxy);
    const raw = (await at.query.proxy.proxies(owner)).toJSON();
    if (
      !Array.isArray(raw) ||
      raw.length !== 2 ||
      !Array.isArray(raw[0]) ||
      raw[0].length > 256
    )
      throw new Error("Invalid proxy response");
    const proxies = raw[0].map((row: unknown) => {
      if (!row || typeof row !== "object")
        throw new Error("Invalid proxy entry");
      const p = row as Record<string, unknown>;
      if (
        typeof p.delegate !== "string" ||
        typeof p.proxyType !== "string" ||
        typeof p.delay !== "number" ||
        !Number.isSafeInteger(p.delay) ||
        p.delay < 0
      )
        throw new Error("Invalid proxy entry");
      return {
        delegate: address(p.delegate),
        proxyType: p.proxyType,
        delay: p.delay,
      };
    });
    // An advertised V1 schema invalidates legacy consent; never fall back on missing/false V1.
    const proxy = at.query.proxy;
    const query =
      "realPaysFeeConsentV1" in proxy
        ? proxy.realPaysFeeConsentV1
        : proxy.realPaysFee;
    if (typeof query !== "function")
      throw new Error("Unsupported fee-consent storage");
    const consent: unknown = await query(owner, delegate);
    let enabled: boolean;
    if (typeof consent === "boolean") enabled = consent;
    else if (consent === null) enabled = false;
    else if (
      consent &&
      typeof consent === "object" &&
      typeof (consent as { isSome?: unknown }).isSome === "boolean" &&
      ((consent as { isNone?: unknown }).isNone === undefined ||
        (consent as { isNone?: unknown }).isNone ===
          !(consent as { isSome: boolean }).isSome)
    )
      enabled = (consent as { isSome: boolean }).isSome;
    else throw new Error("Invalid fee-consent response");
    const timestamp = number(await at.query.timestamp.now());
    wallet.assertCurrentFlow();
    if (api.genesisHash.toHex() !== wallet.genesisHash)
      throw new Error("Permission network changed");
    return {
      genesisHash: wallet.genesisHash,
      walletAddress: owner,
      proxy: delegate,
      stakingProxy: proxies.some(
        (p) =>
          p.delegate === delegate && p.proxyType === "Staking" && p.delay === 0,
      ),
      realPaysFee: enabled,
      blockHash: block.blockHash,
      blockNumber: block.height,
      timestamp,
    };
  };
  return {
    readPermissions: read,
    submitPermissions: async (calls, context, wallet) => {
      const runtime = JSON.stringify(runtimeIdentity(api));
      const assertCurrent = async () => {
        wallet.assertCurrentFlow();
        const current = permissionPlan(
          await read(context, wallet),
          context,
          wallet,
          sameWallet,
        );
        wallet.assertCurrentFlow();
        if (
          !calls.length ||
          JSON.stringify(current) !== JSON.stringify(calls) ||
          JSON.stringify(runtimeIdentity(api)) !== runtime
        )
          throw new Error("Permission plan or runtime changed. Review again.");
      };
      await assertCurrent();
      const tx = api.tx.utility.batchAll(
        calls.map((call) =>
          call.kind === "addStakingProxy"
            ? api.tx.proxy.addProxy(call.delegate, "Staking", 0)
            : api.tx.proxy.setRealPaysFee(call.delegate, true),
        ),
      );
      const receipt = parseChainReceipt(await submit(tx, assertCurrent));
      wallet.assertCurrentFlow();
      await finalizedBlock(receipt);
      const [block, events] = await Promise.all([
        api.rpc.chain.getBlock(receipt.blockHash),
        api.query.system.events.at(receipt.blockHash),
      ]);
      const index = block.block.extrinsics.findIndex(
        (e) => e.hash.toHex() === receipt.transactionHash,
      );
      if (index < 0)
        throw new Error("Permission transaction is absent from receipt block");
      const scoped = (events as unknown as EventRecord[]).filter(
        (e) =>
          e.phase.isApplyExtrinsic &&
          e.phase.asApplyExtrinsic.toNumber() === index,
      );
      if (!decodeBatchEvents(scoped).success)
        throw new Error("Permission dispatch failed or is unverified");
      const after = await read(context, wallet, receipt);
      if (permissionPlan(after, context, wallet, sameWallet).length)
        throw new Error("Permissions were not finalized");
      wallet.assertCurrentFlow();
      return receipt;
    },
  };
}
