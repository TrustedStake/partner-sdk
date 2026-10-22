type ChainValue = {
  toBigInt?: () => bigint;
  toJSON?: () => unknown;
  toString?: () => string;
};

function toBigInt(value: unknown): bigint | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === "string" && /^(?:\d+|0x[\da-f]+)$/i.test(value))
    return BigInt(value);
  const codec = value as ChainValue;
  try {
    if (codec.toBigInt) return codec.toBigInt();
    if (codec.toJSON) {
      const json = codec.toJSON();
      if (json !== value) return toBigInt(json);
    }
    const text = codec.toString?.();
    if (text && /^\d+$/.test(text)) return BigInt(text);
  } catch {
    return undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const codec = value as ChainValue;
  const json = codec.toJSON?.();
  const candidate = json && json !== value ? json : value;
  return typeof candidate === "object" && candidate !== null
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function field(
  record: Record<string, unknown> | undefined,
  ...names: string[]
): unknown {
  if (!record) return undefined;
  for (const name of names) {
    if (name in record) return record[name];
  }
  return undefined;
}

export interface ChainEventLike {
  event: {
    section: unknown;
    method: unknown;
    data?: unknown;
  };
}

export interface BatchEventOutcome {
  success: boolean;
  failedItem?: number;
  reason?: string;
}

function eventData(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const json = (data as ChainValue | undefined)?.toJSON?.();
  return Array.isArray(json) ? json : [];
}

export function decodeBatchEvents(events: ChainEventLike[]): BatchEventOutcome {
  let outerSuccess = false;
  let utilityFailure: BatchEventOutcome | undefined;

  for (const { event } of events) {
    const section = String(event.section);
    const method = String(event.method);
    const data = eventData(event.data);

    if (section === "system" && method === "ExtrinsicFailed") {
      return { success: false, reason: "ExtrinsicFailed" };
    }
    if (section === "system" && method === "ExtrinsicSuccess")
      outerSuccess = true;
    if (
      (section === "proxy" && method === "ProxyExecuted") ||
      (section === "multisig" && method === "MultisigExecuted")
    ) {
      const inner = data.at(-1);
      const result = asRecord(inner);
      if (
        !result ||
        !("ok" in result || "Ok" in result) ||
        "err" in result ||
        "Err" in result
      ) {
        return {
          success: false,
          reason: `${section}.${method} failed or unverified`,
        };
      }
    }
    if (section !== "utility") continue;

    if (method === "BatchInterrupted") {
      utilityFailure = {
        success: false,
        failedItem: Number(toBigInt(data[0]) ?? BigInt(0)),
        reason: "BatchInterrupted",
      };
    } else if (method === "ItemFailed") {
      utilityFailure = { success: false, reason: "ItemFailed" };
    } else if (method === "BatchCompletedWithErrors") {
      utilityFailure = { success: false, reason: "BatchCompletedWithErrors" };
    }
  }

  return (
    utilityFailure ?? {
      success: outerSuccess,
      reason: outerSuccess ? undefined : "Missing ExtrinsicSuccess",
    }
  );
}
