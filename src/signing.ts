import {
  HASH,
  UUID,
  parseChallenge,
  record,
  textValue,
  type JoinContext,
} from "./contracts.ts";
import {
  isReadableWalletMessage,
  validateReadableMessage,
  stringToHex,
} from "./encoding.ts";
import { validatePartnerRequest } from "./request-policy.ts";
import type { Wallet, SigningDependencies } from "./types.ts";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(object[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
export async function signSessionAction(
  sessionId: string,
  token: string | undefined,
  action: "wallet-proof" | "register" | "cancel" | "recover",
  data: Record<string, unknown>,
  wallet: Wallet,
  dependencies: SigningDependencies,
  context?: JoinContext,
): Promise<unknown> {
  const {
    request: partnerRequest,
    now,
    sameWallet,
    readable: useReadable,
    sha256,
  } = dependencies;
  wallet.assertCurrentFlow();
  if (!wallet.signer.signRaw)
    throw new Error(
      "This wallet cannot sign membership messages. Use a supported wallet on TrustedStake.",
    );
  const challengeBody = {
    ...(action === "recover" ? {} : { action, data }),
    ...(useReadable ? { messageFormat: "readable" } : {}),
    signerAddress: wallet.signerAddress,
    managedWalletAddress: wallet.managedWalletAddress,
  };
  const route = action === "recover" ? "recovery-challenges" : "challenges";
  validatePartnerRequest(
    "POST",
    ["join-sessions", sessionId, route],
    new URLSearchParams(),
    challengeBody,
    token ? `Bearer ${token}` : null,
  );
  const challenge = parseChallenge(
    await partnerRequest(
      `join-sessions/${sessionId}/${route}`,
      token,
      challengeBody,
    ),
  );
  if (useReadable && !isReadableWalletMessage(challenge.message))
    throw new Error("Readable wallet signing is unavailable. Please retry.");
  if (isReadableWalletMessage(challenge.message))
    validateReadableMessage(
      challenge.message,
      challenge.challengeId,
      challenge.signingBytes,
    );
  const envelope = record(
    isReadableWalletMessage(challenge.message)
      ? challenge.payload
      : JSON.parse(challenge.message),
  );
  const resourceFields = [
    "partnerId",
    "strategyRef",
    "strategyId",
    "strategyTable",
  ];
  const privateAction = action === "register" || action === "cancel";
  const allowedFields = new Set([
    "domain",
    "version",
    "action",
    "method",
    "path",
    "sessionId",
    "managedWalletAddress",
    "signerAddress",
    "network",
    "genesisHash",
    "nonce",
    "expiresAt",
    "bodyHash",
    "data",
    ...(privateAction ? resourceFields : []),
    ...(action === "register" && data.membershipSharing === "partner_membership"
      ? ["membershipConnection"]
      : []),
  ]);
  if (
    Object.keys(envelope).some((key) => !allowedFields.has(key)) ||
    (privateAction && !context)
  )
    throw new Error("Unexpected fields in the signing request.");

  if (
    action === "register" &&
    data.membershipSharing === "partner_membership"
  ) {
    const connection = record(envelope.membershipConnection);
    if (
      !context?.membershipSharingAvailable ||
      context.membershipSharingScope !== "partner_membership" ||
      Object.keys(connection).length !== 3 ||
      !UUID.test(textValue(connection.id, 36)) ||
      !Number.isSafeInteger(connection.generation) ||
      Number(connection.generation) < 0 ||
      connection.partnerName !== context.partnerName
    )
      throw new Error(
        "The membership sharing approval did not match this partner.",
      );
  }
  const expiry = Date.parse(challenge.expiresAt);
  if (
    envelope.domain !== "trustedstake:partner-join" ||
    envelope.version !== 1 ||
    envelope.action !== action ||
    envelope.method !== "POST" ||
    envelope.path !== `/api/v1/partners/join-sessions/${sessionId}/${action}` ||
    envelope.sessionId !== sessionId ||
    envelope.network !== "finney" ||
    envelope.genesisHash !== wallet.genesisHash ||
    !sameWallet(textValue(envelope.signerAddress, 50), wallet.signerAddress) ||
    !sameWallet(
      textValue(envelope.managedWalletAddress, 50),
      wallet.managedWalletAddress,
    ) ||
    canonical(envelope.data) !== canonical(data) ||
    envelope.expiresAt !== challenge.expiresAt ||
    expiry <= now() ||
    expiry > now() + 6 * 60_000 ||
    !UUID.test(String(envelope.nonce)) ||
    !HASH.test(String(envelope.bodyHash)) ||
    stringToHex(challenge.message).toLowerCase() !==
      challenge.signingBytes.toLowerCase()
  )
    throw new Error(
      "The signing request did not match this wallet, network, session, or action.",
    );
  if (
    context &&
    (envelope.partnerId !== context.partnerId ||
      envelope.strategyRef !== context.strategyRef ||
      envelope.strategyId !== context.strategyId ||
      envelope.strategyTable !== context.strategyTable)
  )
    throw new Error(
      "The signing request changed strategy. Review the join again.",
    );
  if ("0x" + (await sha256(canonical(data))) !== envelope.bodyHash)
    throw new Error("The signing request body did not match your approval.");
  wallet.assertCurrentFlow();
  const { signature } = await wallet.signer.signRaw({
    address: wallet.signerAddress,
    data: challenge.signingBytes,
    type: "bytes",
  });
  wallet.assertCurrentFlow();
  if (expiry <= now())
    throw new Error("The signing request expired while awaiting approval.");
  textValue(signature, 260, /^0x[0-9a-f]{128,132}$/i);
  return partnerRequest(`join-sessions/${sessionId}/${action}`, token, {
    challengeId: challenge.challengeId,
    signature,
  });
}
