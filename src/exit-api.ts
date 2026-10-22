import { exitBeforeBroadcast } from "./exit-submission.ts";
import { HASH, UUID, parseChallenge, record } from "./contracts.ts";
import { canonical } from "./signing.ts";
import { stringToHex } from "./encoding.ts";
import type { Wallet } from "./types.ts";
import type { ExitScope } from "./exit.ts";

export interface ExitSelection {
  strategyId: string;
  strategyTable: "strategies" | "custom_strategies";
  proxy: string;
  expectedGeneration?: string;
}
export interface ExitContext {
  schemaVersion: 1;
  walletAddress: string;
  genesisHash: string;
  selection: Required<ExitSelection>;
  membership: "active" | "ended";
  canStopMembership: boolean;
  otherActiveMemberships: number;
  otherProxyDependencies: unknown[];
  allocation: {
    state: "quiescent" | "pending" | "needs_review";
    unresolvedChainEffects: boolean;
    jobs: unknown[];
  };
  checkedAt: string;
}
export interface ExitCheckout {
  required: boolean;
  bundleId: string | null;
  strategyId: string;
  memberSs58: string;
  network: { name: string; genesisHash: string } | null;
  transfers: { ss58: string; amountRao: string }[];
  totalAmountRao: string;
  paymentReferenceHash: string | null;
  quoteExpiresAt: string | null;
  reviewItems: unknown[];
}
export interface ExitApiOptions {
  partnerId: string;
  wallet: Wallet;
  /** Fixed same-origin bridge; never a partner server key or cross-origin credential. */
  request(path: string, init: RequestInit): Promise<unknown>;
  sameWallet(a: string, b: string): boolean;
  now(): number;
  uuid(): string;
  sha256(value: string): Promise<string>;
}
const SIG = /^0x[0-9a-f]{128,132}$/i;
const RAO = /^(0|[1-9][0-9]*)$/;
const u64 = (v: unknown): string => {
  if (typeof v !== "string" || !RAO.test(v) || BigInt(v) > (1n << 64n) - 1n)
    throw new Error("Invalid fee amount.");
  return v;
};
export function parseExitContext(
  value: unknown,
  selection: ExitSelection,
  wallet: Wallet,
  sameWallet: ExitApiOptions["sameWallet"],
  now: number,
): ExitContext {
  const c = record(value),
    selected = record(c.selection),
    allocation = record(c.allocation);
  const checked = Date.parse(String(c.checkedAt));
  if (
    c.schemaVersion !== 1 ||
    typeof c.walletAddress !== "string" ||
    !sameWallet(c.walletAddress, wallet.managedWalletAddress) ||
    c.genesisHash !== wallet.genesisHash ||
    selected.strategyId !== selection.strategyId ||
    selected.strategyTable !== selection.strategyTable ||
    typeof selected.proxy !== "string" ||
    !sameWallet(selected.proxy, selection.proxy) ||
    !UUID.test(String(selected.expectedGeneration)) ||
    (selection.expectedGeneration &&
      selected.expectedGeneration !== selection.expectedGeneration) ||
    !["active", "ended"].includes(String(c.membership)) ||
    typeof c.canStopMembership !== "boolean" ||
    !Number.isSafeInteger(c.otherActiveMemberships) ||
    Number(c.otherActiveMemberships) < 0 ||
    !Array.isArray(c.otherProxyDependencies) ||
    c.otherProxyDependencies.length > 100 ||
    !Array.isArray(allocation.jobs) ||
    allocation.jobs.length > 100 ||
    !["quiescent", "pending", "needs_review"].includes(
      String(allocation.state),
    ) ||
    typeof allocation.unresolvedChainEffects !== "boolean" ||
    (allocation.state === "quiescent" &&
      (allocation.unresolvedChainEffects || allocation.jobs.length)) ||
    !Number.isFinite(checked) ||
    checked > now + 5000 ||
    now - checked > 60000
  )
    throw new Error("Exit context is stale, changed or unavailable.");
  return structuredClone(c) as unknown as ExitContext;
}
export function parseExitCheckout(
  value: unknown,
  scope: ExitScope,
  sameWallet: ExitApiOptions["sameWallet"],
  now: number,
): ExitCheckout {
  const q = record(value),
    transfers = q.transfers,
    review = q.reviewItems ?? [];
  if (
    typeof q.required !== "boolean" ||
    q.strategyId !== scope.strategyId ||
    typeof q.memberSs58 !== "string" ||
    !sameWallet(q.memberSs58, scope.wallet) ||
    !Array.isArray(transfers) ||
    transfers.length > 100 ||
    !Array.isArray(review) ||
    review.length > 100
  )
    throw new Error("Exit fee review is unavailable.");
  const total = u64(q.totalAmountRao);
  const parsed = transfers.map((raw) => {
    const t = record(raw);
    if (typeof t.ss58 !== "string" || !sameWallet(t.ss58, t.ss58))
      throw new Error("Invalid fee recipient.");
    return { ss58: t.ss58, amountRao: u64(t.amountRao) };
  });
  if (
    parsed.reduce((sum, t) => sum + BigInt(t.amountRao), 0n) !== BigInt(total)
  )
    throw new Error("Fee transfers do not match the disclosed total.");
  const recipe = q.extrinsicRecipe;
  if (q.required) {
    const network = record(q.network),
      r = record(recipe),
      calls = r.calls;
    if (
      !UUID.test(String(q.bundleId)) ||
      network.name !== "finney" ||
      network.genesisHash !== scope.genesisHash ||
      !HASH.test(String(q.paymentReferenceHash)) ||
      !parsed.length ||
      !Number.isFinite(Date.parse(String(q.quoteExpiresAt))) ||
      Date.parse(String(q.quoteExpiresAt)) <= now ||
      Date.parse(String(q.quoteExpiresAt)) > now + 86400000 ||
      r.kind !== "BATCH_ALL_V1" ||
      !Array.isArray(calls) ||
      calls.length !== parsed.length + 1
    )
      throw new Error("Exit fee quote changed or expired.");
    const expected = [
      ...parsed.map((t) => ({
        pallet: "balances",
        method: "transferKeepAlive",
        args: [t.ss58, t.amountRao],
      })),
      {
        pallet: "system",
        method: "remarkWithEvent",
        args: [q.paymentReferenceHash],
      },
    ];
    if (canonical(calls) !== canonical(expected))
      throw new Error("Unsupported fee payment recipe.");
  } else if (
    q.bundleId !== null ||
    parsed.length ||
    BigInt(total) !== 0n ||
    recipe !== null ||
    q.paymentReferenceHash !== null
  )
    throw new Error("Inconsistent empty fee checkout.");
  return structuredClone({
    ...q,
    transfers: parsed,
    reviewItems: review,
  }) as unknown as ExitCheckout;
}
/** An explicit wallet authentication grants short-lived read access, never signing/payment authority. */
export function createNativeExitApi(options: ExitApiOptions) {
  const { wallet, request, partnerId, now, sameWallet } = options;
  if (!UUID.test(partnerId)) throw new Error("Invalid exit partner.");
  let access: { token: string; expiresAt: number } | undefined;
  const call = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    headers?: HeadersInit,
    beforeRequest?: () => void,
  ) => {
    wallet.assertCurrentFlow();
    beforeRequest?.();
    const value = await request(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...Object.fromEntries(new Headers(headers).entries()),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit",
      redirect: "error",
    });
    wallet.assertCurrentFlow();
    return value;
  };
  async function sign(message: string) {
    try {
      wallet.assertCurrentFlow();
      if (!wallet.signer.signRaw)
        throw new Error(
          "A wallet capable of signing membership messages is required.",
        );
      const reply = await wallet.signer.signRaw({
        address: wallet.signerAddress,
        data: stringToHex(message),
        type: "bytes",
      });
      wallet.assertCurrentFlow();
      if (!SIG.test(reply.signature))
        throw new Error("Invalid wallet signature.");
      return reply.signature;
    } catch (error) {
      throw exitBeforeBroadcast(error);
    }
  }
  async function authenticate() {
    const challenge = parseChallenge(
      await call(
        `partners/public/${partnerId}/connections/challenges`,
        "POST",
        {
          action: "read",
          purpose: "exit",
          signerAddress: wallet.signerAddress,
          managedWalletAddress: wallet.managedWalletAddress,
        },
      ),
    );
    const e = record(JSON.parse(challenge.message)),
      expiry = Date.parse(challenge.expiresAt);
    if (
      e.domain !== "trustedstake:partner-connection" ||
      e.version !== 1 ||
      e.action !== "read" ||
      e.method !== "POST" ||
      e.path !== `/api/v1/partners/public/${partnerId}/connections/read` ||
      e.partnerId !== partnerId ||
      !UUID.test(String(e.connectionId)) ||
      !Number.isSafeInteger(e.generation) ||
      Number(e.generation) < 0 ||
      typeof e.signerAddress !== "string" ||
      !sameWallet(e.signerAddress, wallet.signerAddress) ||
      typeof e.managedWalletAddress !== "string" ||
      !sameWallet(e.managedWalletAddress, wallet.managedWalletAddress) ||
      e.network !== "finney" ||
      e.genesisHash !== wallet.genesisHash ||
      !UUID.test(String(e.nonce)) ||
      canonical(e.data) !== canonical({ purpose: "exit" }) ||
      e.bodyHash !==
        `0x${await options.sha256(canonical({ purpose: "exit" }))}` ||
      e.expiresAt !== challenge.expiresAt ||
      expiry <= now() ||
      expiry > now() + 360000 ||
      stringToHex(challenge.message) !== challenge.signingBytes
    )
      throw new Error(
        "Exit authentication does not match this wallet, network or purpose.",
      );
    const signature = await sign(challenge.message);
    if (expiry <= now()) throw new Error("Exit authentication expired.");
    const result = record(
      await call(`partners/public/${partnerId}/connections/read`, "POST", {
        challengeId: challenge.challengeId,
        signature,
      }),
    );
    const token = result.managementToken,
      until = Date.parse(String(result.expiresAt));
    if (
      result.scope !== "wallet_exit" ||
      result.connectionId !== e.connectionId ||
      result.partnerId !== partnerId ||
      typeof result.walletAddress !== "string" ||
      !sameWallet(result.walletAddress, wallet.managedWalletAddress) ||
      typeof token !== "string" ||
      !new RegExp(`^tse_${challenge.challengeId}_[a-f0-9]{64}$`).test(token) ||
      !Number.isFinite(until) ||
      until <= now() ||
      until > now() + 901000
    )
      throw new Error("Exit read capability is unavailable.");
    access = { token, expiresAt: until };
  }
  async function context(selection: ExitSelection) {
    if (!access || access.expiresAt <= now())
      throw new Error("Authorize exit review with your wallet.");
    const params = new URLSearchParams(
      Object.entries(selection).filter(([, v]) => v !== undefined) as [
        string,
        string,
      ][],
    );
    return parseExitContext(
      await call(
        `partners/public/${partnerId}/connections/exit-context?${params}`,
        "GET",
        undefined,
        { authorization: `Bearer ${access.token}` },
      ),
      selection,
      wallet,
      sameWallet,
      now(),
    );
  }
  async function signed(
    path: string,
    action: string,
    data: Record<string, unknown>,
    method: "GET" | "POST" = "POST",
    body: Record<string, unknown> = {},
    beforeRequest?: () => void,
  ) {
    const nonce = options.uuid();
    if (!UUID.test(nonce)) throw new Error("Invalid request nonce.");
    const message = JSON.stringify({
      action,
      timestamp: now(),
      nonce,
      signerAddress: wallet.signerAddress,
      managedWalletAddress: wallet.managedWalletAddress,
      data,
    });
    const signature = await sign(message);
    return call(
      path,
      method,
      method === "GET" ? undefined : body,
      {
        "x-wallet-address": wallet.managedWalletAddress,
        "x-signer-address": wallet.signerAddress,
        "x-message": message,
        "x-signature": signature,
      },
      beforeRequest,
    );
  }
  async function stop(scope: ExitScope) {
    let mutationHandedOff = false;
    try {
      const data = {
        strategyId: scope.strategyId,
        strategyTable: scope.strategyTable,
        proxy: scope.delegate,
        expectedGeneration: scope.generation,
        genesisHash: scope.genesisHash,
      };
      const selection = {
        strategyId: scope.strategyId,
        strategyTable: scope.strategyTable,
        proxy: scope.delegate,
        expectedGeneration: scope.generation,
      };
      if (
        scope.genesisHash !== wallet.genesisHash ||
        !sameWallet(scope.wallet, wallet.managedWalletAddress) ||
        !sameWallet(scope.signer, wallet.signerAddress)
      )
        throw new Error("Exit wallet or network changed.");
      const current = await context(selection);
      if (current.membership === "ended") return current;
      if (!current.canStopMembership)
        throw new Error(
          "This legacy membership needs review in the TrustedStake app.",
        );
      const result = record(
        await signed(
          "membership/unregister",
          "unregister_membership",
          data,
          "POST",
          {},
          () => {
            mutationHandedOff = true;
          },
        ),
      );
      const receipt = record(result.data);
      if (result.success !== true)
        throw new Error("Membership cessation is unverified. Refresh status.");
      const stopped = parseExitContext(
        receipt.exit,
        selection,
        wallet,
        sameWallet,
        now(),
      );
      if (stopped.membership !== "ended")
        throw new Error("Membership cessation is unverified.");
      return stopped;
    } catch (error) {
      if (!mutationHandedOff) throw exitBeforeBroadcast(error);
      throw error;
    }
  }
  async function feeRequest(
    path: string,
    body: Record<string, unknown> = {},
    method: "GET" | "POST" = "POST",
  ) {
    const route = `/api/v1/${path}`;
    const data = {
      schemaVersion: 1,
      domain: "TrustedStake Fee Request",
      method,
      route,
      walletAddress: wallet.managedWalletAddress,
      chain: "finney",
      genesisHash: wallet.genesisHash,
      bodyHash: `0x${await options.sha256(canonical(body))}`,
    };
    return record(
      await signed(
        path,
        method === "GET"
          ? "view_fee_obligations"
          : path.endsWith("/submitted")
            ? "submit_fee_payment"
            : "quote_fee_obligation",
        data,
        method,
        body,
      ),
    );
  }
  return {
    sameWallet,
    authenticate,
    context,
    stop,
    async checkout(scope: ExitScope) {
      const result = await feeRequest(
        `fees/me/strategies/${scope.strategyId}/exit-checkout`,
      );
      if (result.success !== true)
        throw new Error("Exit fees are unavailable.");
      return parseExitCheckout(result.data, scope, sameWallet, now());
    },
    async recordFeePayment(
      bundleId: string,
      receipt: {
        transactionHash: string;
        blockHash: string;
        blockNumber: number;
        extrinsicIndex: number;
      },
      expected: ExitCheckout,
    ) {
      if (!UUID.test(bundleId)) throw new Error("Invalid fee bundle.");
      const result = await feeRequest(`fees/me/bundles/${bundleId}/submitted`, {
        transactionHash: receipt.transactionHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber,
        extrinsicIndex: receipt.extrinsicIndex,
      });
      if (result.success !== true)
        throw new Error("Fee settlement is unverified.");
      const acknowledged = record(result.data),
        network = record(acknowledged.network);
      if (
        !expected ||
        expected.bundleId !== bundleId ||
        acknowledged.bundleId !== bundleId ||
        acknowledged.strategyId !== expected.strategyId ||
        typeof acknowledged.memberSs58 !== "string" ||
        !sameWallet(acknowledged.memberSs58, wallet.managedWalletAddress) ||
        network.genesisHash !== wallet.genesisHash ||
        acknowledged.paymentReferenceHash !== expected.paymentReferenceHash ||
        acknowledged.totalAmountRao !== expected.totalAmountRao ||
        !Array.isArray(acknowledged.transfers) ||
        acknowledged.transfers.length !== expected.transfers.length
      )
        throw new Error(
          "Fee settlement acknowledgement does not match the approved bundle.",
        );
      for (let i = 0; i < expected.transfers.length; i++) {
        const t = record(acknowledged.transfers[i]);
        if (
          typeof t.ss58 !== "string" ||
          !sameWallet(t.ss58, expected.transfers[i].ss58) ||
          t.amountRao !== expected.transfers[i].amountRao
        )
          throw new Error(
            "Fee settlement acknowledgement changed recipients or amounts.",
          );
      }
      return acknowledged;
    },
  };
}
