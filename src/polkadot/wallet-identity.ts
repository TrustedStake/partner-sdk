import { decodeAddress } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";

/** SS58 prefixes are display formats, not distinct accounts. Invalid identities never compare equal. */
export function sameWallet(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (!a || !b) return false;
  try {
    const left = decodeAddress(a),
      right = decodeAddress(b);
    return (
      left.length === 32 &&
      right.length === 32 &&
      u8aToHex(left) === u8aToHex(right)
    );
  } catch {
    return false;
  }
}
