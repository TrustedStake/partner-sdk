export const stringToHex = (value: string): string =>
  "0x" +
  Array.from(new TextEncoder().encode(value), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Recognition only: callers must validate the exact issued message before signing. */
export function isReadableWalletMessage(message: string): boolean {
  return (
    message.startsWith("TrustedStake - ") ||
    message.startsWith("TrustedStake — ")
  );
}
/** ASCII header transport; wallet signs the original text, never this encoding. */
export function signingMessageHeader(message: string): string {
  return isReadableWalletMessage(message) ? stringToHex(message) : message;
}
export function canonicalSigningValue(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalSigningValue).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalSigningValue(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function validateReadableMessage(
  message: string,
  requestId: string,
  signingBytes?: string,
): void {
  const printable =
    /^TrustedStake - ([\x20-\x7b\x7d-\x7e]{1,200}) \| Request: [0-9a-f-]{36}$/.exec(
      message,
    );
  // Previously issued challenges remain valid as issued until the server expiry.
  const compatible =
    /^TrustedStake — [^\r\n\u0000-\u001f]{1,200}\n\nRequest: [0-9a-f-]{36}$/.test(
      message,
    );
  if (
    !UUID.test(requestId) ||
    message.length > 400 ||
    (!(
      printable &&
      printable[1].trim() === printable[1] &&
      printable[1].length > 0
    ) &&
      !compatible) ||
    !message.endsWith(`Request: ${requestId}`) ||
    (signingBytes !== undefined && stringToHex(message) !== signingBytes)
  )
    throw new Error("Invalid readable wallet request.");
}
