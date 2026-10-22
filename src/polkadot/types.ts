export type PendingMultisigOpStatus =
  | "draft"
  | "pending_approvals"
  | "ready_to_execute"
  | "executed"
  | "cancelled"
  | "failed"
  | "needs_review";

export type PendingMultisigOperationKind =
  | "add_proxy"
  | "remove_proxy"
  | "other";

export type MultisigTimepoint = {
  height: number;
  index: number;
};

export type MultisigWeight = {
  refTime: string;
  proofSize: string;
};

export type PendingMultisigOp = {
  id: string;
  chainId: string;
  threshold: number;
  signatories: string[];
  sortedSignatories: string[];
  currentSigner?: string;
  otherSignatories?: string[];
  multisigAddress: string;
  managedAccount: string;
  proxyDelegate?: string | null;
  proxyType?: string | null;
  operationKind: PendingMultisigOperationKind;
  operationLabel: string;
  callDataHex: string;
  callHashHex: string;
  timepoint?: MultisigTimepoint | null;
  maxWeight?: MultisigWeight | null;
  status: PendingMultisigOpStatus;
  createdAt: string;
  updatedAt: string;
  extrinsicHash?: string;
  blockHash?: string;
  runtime?: { specVersion: number; transactionVersion: number };
  approvals?: string[];
  depositor?: string;
  error?: string;
  authorizationProof?: { challengeId: string; expiresAt: string };
};

export type MultisigConfig = {
  enabled: boolean;
  threshold: number;
  signatories: string[];
  managedAccount: string;
  proxyType: string | null;
};

export type MultisigRuntimeCapabilities = {
  isReady: boolean;
  chainId: string | null;
  chainName: string | null;
  ss58Prefix: number;
  hasMultisig: boolean;
  hasProxy: boolean;
  hasProxyAddRemove: boolean;
  hasMultisigStorage: boolean;
  hasAsMultiThreshold1: boolean;
  maxSignatories: number | null;
  depositBase: string | null;
  depositFactor: string | null;
};

export type MultisigSubmitType =
  | "approve"
  | "approve_execute"
  | "execute"
  | "threshold_1"
  | "cancel";

export type MultisigSubmissionOutcome = {
  op: PendingMultisigOp;
  submitType: MultisigSubmitType;
  resultHash?: string;
  blockHash?: string;
};

export type MultisigSignerAuthorizationStatus =
  | "not_authorized"
  | "authorizing"
  | "authorized"
  | "failed";

export type MultisigSignerAuthorizationRecord = {
  managedWalletAddress: string;
  signerAddress: string;
  chainId: string;
  challengeId?: string;
  expiresAt?: string;
  verifiedAt: string;
};
