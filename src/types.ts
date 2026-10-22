import type { MutationCoordinator } from "./ownership.ts";
/** No wallet extension, Node runtime, React or chain-library dependency. */
export interface Wallet {
  signer: {
    signRaw?: (input: {
      address: string;
      data: string;
      type: "bytes";
    }) => Promise<{ signature: string }>;
  };
  signerAddress: string;
  managedWalletAddress: string;
  genesisHash: string;
  /** Must throw after account/network/session changes, including while a wallet popup is open. */
  assertCurrentFlow(): void;
}
export type PartnerRequest = (
  path: string,
  token?: string,
  body?: unknown,
) => Promise<unknown>;
export interface SigningDependencies {
  request: PartnerRequest;
  now(): number;
  /** Return a lowercase 64-character SHA256 hex digest, without 0x. */
  sha256(value: string): Promise<string>;
  /** Inject SS58 normalization when supporting multiple address prefixes. */
  sameWallet(a: string, b: string): boolean;
  readable: boolean;
}
export interface AllocationDependencies extends Omit<
  SigningDependencies,
  "request"
> {
  request(path: string, init: RequestInit): Promise<unknown>;
}
export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface Dependencies extends Omit<SigningDependencies, "request"> {
  fetch: typeof fetch;
  storage: Storage;
  /** Share only public pending-operation records across tabs; keep access/read tokens tab scoped. */
  journalStorage?: Storage;
  /** Required by hosts that allow multiple tabs/controllers for this scope. */
  coordinator?: MutationCoordinator;
  /** Same-origin partner bridge URL. Never put a partner API key in the browser. */
  baseUrl: string;
  allocationBaseUrl: string;
  /** Redacted events only: no signatures, tokens, wallet addresses or response bodies. */
  onEvent?: (event: {
    operation: string;
    outcome: "requested" | "completed" | "failed";
  }) => void;
}
