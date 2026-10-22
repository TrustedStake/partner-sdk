export type FeeCadence = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY";
export type ManagementFeeMode = "OFF" | "AUM_PERCENT" | "FLAT_PERIODIC";

export interface PublicFeePolicy {
  id: string;
  version: number;
  feeTermsHash: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  managementFeeMode: ManagementFeeMode;
  managementFeeCadence: FeeCadence | null;
  managementFeeBpsAnnual: number | null;
  flatFeeRao: string | null;
  performanceFeeEnabled: boolean;
  performanceFeeCadence: FeeCadence | null;
  performanceFeeBps: number | null;
  graceDays: number;
  quoteTtlSeconds: number;
  minimumBillableRao: string;
}

export interface PublicStrategyFeePolicy {
  strategyId: string;
  feeEnabled: boolean;
  currentPolicy: PublicFeePolicy | null;
  scheduledPolicy: PublicFeePolicy | null;
  disclosure: string | null;
}

// Strategy IDs include UUIDv6. Restricting this to v1–v5 silently bypassed fees.
export const isStrategyId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

export function currentFeeTermsHash(
  policy: PublicStrategyFeePolicy,
  strategyId: string,
): string | undefined {
  if (
    !policy ||
    policy.strategyId !== strategyId ||
    typeof policy.feeEnabled !== "boolean"
  ) {
    throw new Error(
      "Unable to verify this strategy's fee policy. Refresh and try again.",
    );
  }
  if (!policy.feeEnabled) return undefined;
  const current = policy.currentPolicy;
  if (!current || !/^0x[0-9a-f]{64}$/i.test(current.feeTermsHash)) {
    throw new Error(
      "Current fee terms are unavailable. Please try again before joining.",
    );
  }
  return current.feeTermsHash;
}

/** Financial disclosure must never turn missing or malformed values into zero fees. */
export function assertReviewableFeePolicy(
  policy: PublicStrategyFeePolicy,
  strategyId: string,
): void {
  if (!currentFeeTermsHash(policy, strategyId)) return;
  const terms = policy.currentPolicy!;
  const cadence = (value: unknown) =>
    typeof value === "string" &&
    ["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY"].includes(value);
  const integer = (value: unknown, min: number, max: number) =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max;
  const rao = (value: unknown) =>
    typeof value === "string" && /^\d{1,30}$/.test(value);
  const date = (value: unknown) =>
    typeof value === "string" &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value));
  if (
    !integer(terms.version, 1, Number.MAX_SAFE_INTEGER) ||
    !date(terms.effectiveFrom) ||
    (terms.effectiveTo !== null &&
      terms.effectiveTo !== undefined &&
      !date(terms.effectiveTo)) ||
    !integer(terms.graceDays, 0, 90) ||
    !integer(terms.quoteTtlSeconds, 60, 86400) ||
    !rao(terms.minimumBillableRao) ||
    !["OFF", "AUM_PERCENT", "FLAT_PERIODIC"].includes(
      terms.managementFeeMode,
    ) ||
    (terms.managementFeeMode !== "OFF" &&
      !cadence(terms.managementFeeCadence)) ||
    (terms.managementFeeMode === "AUM_PERCENT" &&
      !integer(terms.managementFeeBpsAnnual, 0, 10000)) ||
    (terms.managementFeeMode === "FLAT_PERIODIC" && !rao(terms.flatFeeRao)) ||
    typeof terms.performanceFeeEnabled !== "boolean" ||
    (terms.performanceFeeEnabled &&
      (!integer(terms.performanceFeeBps, 0, 10000) ||
        !cadence(terms.performanceFeeCadence))) ||
    (policy.disclosure != null &&
      (typeof policy.disclosure !== "string" ||
        policy.disclosure.length > 10000))
  ) {
    throw new Error(
      "The fee policy is incomplete. Reload the terms before signing.",
    );
  }
}
