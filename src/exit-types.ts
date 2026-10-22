/** Framework-neutral exit review data; no chain-library dependency. */
export interface ExitPosition {
  hotkey: string;
  netuid: number;
  amountRao: string;
  lockedRao: string;
}
export interface ExitChainState {
  runtime: string;
  blockHash: string;
  blockNumber: number;
  checkedAt: number;
  proxyPresent: boolean;
  positions: ExitPosition[];
}
export interface ExitConversionSelection {
  hotkey: string;
  netuid: number;
  amountRao: string;
}
export interface ExitConversionQuote {
  selected: ExitConversionSelection[];
  executable: {
    hotkey: string;
    netuid: number;
    amountRao: string;
    minimumPriceRao: string;
    estimatedTaoRao: string;
  }[];
  skipped: {
    hotkey: string;
    netuid: number;
    reason: "locked" | "disabled" | "below-minimum" | "price-protection";
  }[];
  slippageBps: number | null;
  protection: "relative-price" | "fixed-minimum";
  allowPartial: boolean;
  expiresAt: number;
}
