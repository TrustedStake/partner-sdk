const provenUnsent = new WeakSet<object>();
/** Internal evidence from a submitter that has not called broadcast. Never classify a generic network error this way. */
export function exitBeforeBroadcast(error: unknown): Error {
  const value = new Error(
    error instanceof Error
      ? error.message
      : "The wallet did not sign this transaction.",
  );
  provenUnsent.add(value);
  return value;
}
export function isExitBeforeBroadcast(error: unknown): boolean {
  return !!error && typeof error === "object" && provenUnsent.has(error);
}
