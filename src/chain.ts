import { HASH, textValue } from "./contracts.ts";
import type { JoinContext } from "./contracts.ts";
import type { Wallet } from "./types.ts";
export interface PermissionSnapshot {
  genesisHash: string;
  walletAddress: string;
  proxy: string;
  stakingProxy: boolean;
  realPaysFee: boolean;
  blockHash: string;
  blockNumber: number;
  timestamp: number;
}
export interface ChainReceipt {
  transactionHash: string;
  blockHash: string;
}
export type PermissionCall =
  | { kind: "addStakingProxy"; delegate: string; delay: 0 }
  | { kind: "setRealPaysFee"; delegate: string; value: true };
/** Optional adapter contract. Implement reads at one finalized block and batchAll calls atomically.
 * A receipt must confirm dispatch success. This interface cannot execute staking trades. */
export interface ChainAdapter {
  readPermissions(
    context: JoinContext,
    wallet: Wallet,
    receipt?: ChainReceipt,
  ): Promise<PermissionSnapshot>;
  submitPermissions(
    calls: readonly PermissionCall[],
    context: JoinContext,
    wallet: Wallet,
  ): Promise<ChainReceipt>;
}
export function permissionPlan(
  snapshot: PermissionSnapshot,
  context: JoinContext,
  wallet: Wallet,
  sameWallet: (a: string, b: string) => boolean,
): PermissionCall[] {
  if (
    snapshot.genesisHash !== context.genesisHash ||
    snapshot.genesisHash !== wallet.genesisHash ||
    !sameWallet(snapshot.walletAddress, wallet.managedWalletAddress) ||
    !sameWallet(snapshot.proxy, context.proxy) ||
    typeof snapshot.stakingProxy !== "boolean" ||
    typeof snapshot.realPaysFee !== "boolean" ||
    !HASH.test(snapshot.blockHash) ||
    !Number.isSafeInteger(snapshot.blockNumber) ||
    snapshot.blockNumber < 0 ||
    !Number.isSafeInteger(snapshot.timestamp) ||
    snapshot.timestamp < 0
  )
    throw new Error("Unverified strategy permissions.");
  return [
    ...(!snapshot.stakingProxy
      ? [
          {
            kind: "addStakingProxy" as const,
            delegate: context.proxy,
            delay: 0 as const,
          },
        ]
      : []),
    ...(!snapshot.realPaysFee
      ? [
          {
            kind: "setRealPaysFee" as const,
            delegate: context.proxy,
            value: true as const,
          },
        ]
      : []),
  ];
}
export function parseChainReceipt(value: unknown): ChainReceipt {
  if (!value || typeof value !== "object")
    throw new Error("Missing transaction receipt.");
  const receipt = value as ChainReceipt;
  return {
    transactionHash: textValue(receipt.transactionHash, 66, HASH),
    blockHash: textValue(receipt.blockHash, 66, HASH),
  };
}
