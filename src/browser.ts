import {
  parseAccess,
  parseCatalog,
  parseContext,
  parseFrameConfig,
  parseLaunch,
  parseStatus,
  record,
  textValue,
  TOKEN,
  UUID,
  type JoinContext,
  type SessionAccess,
  type SessionStatus,
} from "./contracts.ts";
import { currentFeeTermsHash, assertReviewableFeePolicy } from "./fees.ts";
import { canonical, signSessionAction } from "./signing.ts";
import {
  fetchInitialAllocation,
  canRenewInitialAllocation,
  requestInitialAllocation,
  parseInitialAllocationAccess,
  type InitialAllocationAccess,
} from "./allocation.ts";
import {
  permissionPlan,
  parseChainReceipt,
  type ChainAdapter,
} from "./chain.ts";
import { transport } from "./transport.ts";
import type { Dependencies, Wallet } from "./types.ts";
export * from "./core.ts";
export { ServiceError } from "./transport.ts";

export interface ReturnContext {
  returnDestinationId?: string;
  state?: string;
}
export interface Anchor {
  fromBlock: number;
  fromTimestamp: number;
}
export interface Review {
  context: JoinContext;
  feeTermsHash: string | undefined;
}
export interface Snapshot {
  context: JoinContext;
  status: SessionStatus;
  pending: "permissions" | "register" | "allocation" | null;
}
interface Pending {
  version: 1;
  sessionId: string;
  signer: string;
  wallet: string;
  genesis: string;
  strategyId: string;
  kind: NonNullable<Snapshot["pending"]>;
  anchor?: Anchor;
  requestId?: string;
}
const active = (status: SessionStatus) =>
  ["active", "suspended"].includes(status.membership?.current ?? "");
function anchor(value: Anchor): Anchor {
  if (
    !Number.isSafeInteger(value.fromBlock) ||
    value.fromBlock < 0 ||
    !Number.isSafeInteger(value.fromTimestamp) ||
    value.fromTimestamp < 0
  )
    throw new Error("Invalid membership anchor.");
  return { fromBlock: value.fromBlock, fromTimestamp: value.fromTimestamp };
}

/** Single wallet/session controller. Mutations never retry automatically. Use one owner per session. */
export function createPartnerClient(deps: Dependencies) {
  const http = transport(deps);
  const inflight = new Map<string, Promise<SessionAccess>>();
  const key = (id: string) => `trustedstake:sdk:v1:access:${id}`;
  const save = (value: SessionAccess) =>
    deps.storage.setItem(key(value.sessionId), JSON.stringify(value));
  const read = (id: string): SessionAccess | null => {
    const stored = deps.storage.getItem(key(id));
    if (!stored) return null;
    try {
      const access = parseAccess(JSON.parse(stored));
      if (access.sessionId !== id || Date.parse(access.expiresAt) <= deps.now())
        throw new Error("Expired access.");
      return access;
    } catch {
      deps.storage.removeItem(key(id));
      return null;
    }
  };
  return {
    catalog: async (partnerId: string, cursor?: string) =>
      parseCatalog(
        await http.partner(
          `public/${partnerId}/strategies${cursor ? `?cursor=${cursor}` : ""}`,
        ),
      ),
    launch: async (
      partnerId: string,
      strategyRef: string,
      idempotencyKey: string,
      returns: ReturnContext = {},
    ) =>
      parseLaunch(
        await http.partner(`public/${partnerId}/join-sessions`, undefined, {
          strategyRef,
          idempotencyKey,
          ...returns,
        }),
      ),
    launchInvite: async (
      launchId: string,
      idempotencyKey: string,
      returns: ReturnContext = {},
    ) =>
      parseLaunch(
        await http.partner(`launch/${launchId}/join-sessions`, undefined, {
          idempotencyKey,
          ...returns,
        }),
      ),
    /** Pass a fragment token after removing it from location/history. No query-string tokens. */
    open: async (
      sessionId: string,
      launchToken?: string,
    ): Promise<SessionAccess> => {
      textValue(sessionId, 36, UUID);
      const running = inflight.get(sessionId);
      if (running) return running;
      if (!launchToken) {
        const cached = read(sessionId);
        if (cached) return cached;
        throw new Error("Open a fresh partner link or recover the session.");
      }
      textValue(launchToken, 256, TOKEN);
      const exchange = http
        .partner(`join-sessions/${sessionId}/exchange`, undefined, {
          launchToken,
        })
        .then((value) => {
          const access = parseAccess(value);
          if (
            access.sessionId !== sessionId ||
            Date.parse(access.expiresAt) <= deps.now()
          )
            throw new Error("Invalid exchanged session.");
          save(access);
          return access;
        });
      inflight.set(sessionId, exchange);
      try {
        return await exchange;
      } finally {
        inflight.delete(sessionId);
      }
    },
    /** Recovery is read-only. It cannot grant action access or authorize a new allocation. */
    recover: async (sessionId: string, wallet: Wallet) => {
      textValue(sessionId, 36, UUID);
      const raw = record(
        await signSessionAction(sessionId, undefined, "recover", {}, wallet, {
          ...deps,
          request: http.partner,
        }),
      );
      const token = textValue(raw.recoveryToken, 256, TOKEN);
      const status = parseStatus(
        await http.partner(`join-sessions/${sessionId}`, token),
      );
      wallet.assertCurrentFlow();
      if (
        status.sessionId !== sessionId ||
        (status.membership?.walletAddress &&
          !deps.sameWallet(
            status.membership.walletAddress,
            wallet.managedWalletAddress,
          ))
      )
        throw new Error("Wrong recovery session.");
      return status;
    },
    session: (initial: SessionAccess, wallet: Wallet, chain?: ChainAdapter) =>
      createSession(initial, wallet, chain, deps, http, save),
  };
}

function createSession(
  initial: SessionAccess,
  wallet: Wallet,
  chain: ChainAdapter | undefined,
  deps: Dependencies,
  http: ReturnType<typeof transport>,
  save: (access: SessionAccess) => void,
) {
  let access = parseAccess(initial);
  const id = access.sessionId;
  const journalStorage = deps.journalStorage ?? deps.storage;
  const journalKey = `trustedstake:sdk:v1:pending:${id}`;
  const allocationKey = `trustedstake:sdk:v1:allocation:${id}`;
  let context: JoinContext | undefined;
  let busy: { key: string; result: Promise<unknown> } | undefined;
  let features: string[] | undefined;
  const walletIdentity = {
    signer: wallet.signerAddress,
    wallet: wallet.managedWalletAddress,
    genesis: wallet.genesisHash,
  };
  const guard = () => {
    wallet.assertCurrentFlow();
    if (
      wallet.signerAddress !== walletIdentity.signer ||
      wallet.managedWalletAddress !== walletIdentity.wallet ||
      wallet.genesisHash !== walletIdentity.genesis ||
      Date.parse(access.expiresAt) <= deps.now()
    )
      throw new Error("Wallet, network or session changed.");
  };
  const bound = (fresh: JoinContext, previous?: JoinContext) => {
    guard();
    if (
      (previous?.walletVerified !== false &&
        previous !== undefined &&
        fresh.walletVerified === false) ||
      fresh.sessionId !== id ||
      fresh.genesisHash !== wallet.genesisHash ||
      (fresh.walletVerified !== false &&
        (!deps.sameWallet(
          fresh.managedWalletAddress ?? "",
          wallet.managedWalletAddress,
        ) ||
          !deps.sameWallet(fresh.signerAddress ?? "", wallet.signerAddress))) ||
      (previous &&
        [
          "partnerId",
          "partnerName",
          "strategyId",
          "strategyRef",
          "strategyTable",
          "proxy",
          "accessMode",
          "genesisHash",
        ].some(
          (k) =>
            fresh[k as keyof JoinContext] !== previous[k as keyof JoinContext],
        ))
    )
      throw new Error("Response changed wallet, network or strategy.");
    if (Date.parse(fresh.expiresAt) <= deps.now())
      throw new Error("Session context expired.");
    return fresh;
  };
  const status = async () => {
    guard();
    const result = parseStatus(
      await http.partner(`join-sessions/${id}`, access.observerToken),
    );
    guard();
    if (
      result.sessionId !== id ||
      (context && result.strategyRef !== context.strategyRef) ||
      (result.membership?.walletAddress &&
        !deps.sameWallet(
          result.membership.walletAddress,
          wallet.managedWalletAddress,
        ))
    )
      throw new Error("Wrong membership response.");
    return result;
  };
  const refresh = async () => {
    guard();
    const fresh = bound(
      parseContext(
        await http.partner(`join-sessions/${id}/context`, access.actionToken),
      ),
      context,
    );
    context = fresh;
    return fresh;
  };
  const pending = (): Pending | null => {
    const value = journalStorage.getItem(journalKey);
    if (!value) return null;
    const p = record(JSON.parse(value));
    if (
      Object.keys(p).some(
        (k) =>
          ![
            "version",
            "sessionId",
            "signer",
            "wallet",
            "genesis",
            "strategyId",
            "kind",
            "anchor",
            "requestId",
          ].includes(k),
      ) ||
      (p.requestId !== undefined && !UUID.test(String(p.requestId))) ||
      p.version !== 1 ||
      p.sessionId !== id ||
      !["permissions", "register", "allocation"].includes(String(p.kind)) ||
      p.signer !== walletIdentity.signer ||
      p.wallet !== walletIdentity.wallet ||
      p.genesis !== walletIdentity.genesis ||
      !UUID.test(String(p.strategyId)) ||
      (context && p.strategyId !== context.strategyId)
    )
      throw new Error(
        "Stored operation belongs to another wallet or strategy. Reconcile it in the original flow.",
      );
    if (p.anchor) anchor(record(p.anchor) as unknown as Anchor);
    return p as unknown as Pending;
  };
  const mark = (kind: Pending["kind"], from?: Anchor, requestId?: string) => {
    if (!context) throw new Error("Review the strategy first.");
    guard();
    // Storage failure aborts BEFORE an irreversible submission.
    journalStorage.setItem(
      journalKey,
      JSON.stringify({
        version: 1,
        sessionId: id,
        ...walletIdentity,
        strategyId: context.strategyId,
        kind,
        ...(from ? { anchor: anchor(from) } : {}),
        ...(requestId ? { requestId } : {}),
      }),
    );
  };
  const clear = () => journalStorage.removeItem(journalKey);
  const requireNoPending = () => {
    if (pending())
      throw new Error(
        "An earlier operation needs reconciliation. Do not submit a replacement.",
      );
  };
  const capability = async (feature: string) => {
    if (!features) {
      const frame = parseFrameConfig(
        await http.partner(`join-sessions/${id}/frame-config`),
      );
      if (context && frame.partnerId !== context.partnerId)
        throw new Error("Capabilities changed partner.");
      features = frame.features ?? [];
    }
    if (!features.includes(feature))
      throw new Error(
        `Partner capability unavailable: ${feature}. Enable and qualify this capability before continuing.`,
      );
  };
  const run = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (busy) {
      if (busy.key === key) return busy.result as Promise<T>;
      return Promise.reject(new Error("Another wallet action is in progress."));
    }
    const result = Promise.resolve()
      .then(() => (deps.coordinator ? deps.coordinator.run(fn) : fn()))
      .finally(() => {
        busy = undefined;
      });
    busy = { key, result };
    return result;
  };
  const review = async (): Promise<Review> => {
    const fresh = await refresh();
    if (!fresh.feePolicy) throw new Error("Current fee policy is unavailable.");
    assertReviewableFeePolicy(fresh.feePolicy, fresh.strategyId);
    const hash = currentFeeTermsHash(fresh.feePolicy, fresh.strategyId);
    if ((hash ?? null) !== fresh.feeTermsHash)
      throw new Error("Fee disclosure and join terms disagree.");
    return { context: structuredClone(fresh), feeTermsHash: hash };
  };
  const checkReview = async (reviewed: Review) => {
    const fresh = await review();
    if (
      reviewed.context.sessionId !== id ||
      canonical([
        fresh.context.strategyId,
        fresh.context.proxy,
        fresh.context.targetConstituents,
        fresh.context.rebalancingRules,
        fresh.context.feeTermsHash,
      ]) !==
        canonical([
          reviewed.context.strategyId,
          reviewed.context.proxy,
          reviewed.context.targetConstituents,
          reviewed.context.rebalancingRules,
          reviewed.context.feeTermsHash,
        ]) ||
      fresh.feeTermsHash !== reviewed.feeTermsHash
    )
      throw new Error("Strategy or fee terms changed. Review them again.");
    if (fresh.context.availability !== "joinable")
      throw new Error("Strategy is not accepting joins.");
    return fresh.context;
  };
  const acceptBound = (raw: Record<string, unknown>) => {
    const fresh = bound(parseContext(raw.context), context);
    if (fresh.walletVerified === false)
      throw new Error("Wallet proof was not accepted.");
    const next = parseAccess({
      ...access,
      actionToken: raw.actionToken,
      expiresAt: raw.expiresAt,
    });
    if (Date.parse(next.expiresAt) <= deps.now())
      throw new Error("Accepted session expired.");
    save(next);
    access = next;
    context = fresh;
  };
  const performPermissions = async (reviewed: Review): Promise<Anchor> => {
    requireNoPending();
    await capability("memberships:manage");
    const fresh = await checkReview(reviewed);
    if (!chain)
      throw new Error("A finalized chain adapter is required for setup.");
    guard();
    const before = await chain.readPermissions(fresh, wallet);
    guard();
    const calls = permissionPlan(before, fresh, wallet, deps.sameWallet);
    const from = anchor({
      fromBlock: before.blockNumber,
      fromTimestamp: before.timestamp,
    });
    if (!calls.length) return from;
    const progress = await status();
    if (
      ["submitted", "awaiting_confirmation"].includes(
        progress.checkpoint?.phase ?? "",
      )
    )
      throw new Error(
        "An earlier transaction may be pending. Reconcile before submitting.",
      );
    mark("permissions", from);
    const receipt = parseChainReceipt(
      await chain.submitPermissions(calls, fresh, wallet),
    );
    guard();
    const after = await chain.readPermissions(fresh, wallet, receipt);
    guard();
    if (
      after.blockNumber < before.blockNumber ||
      (after.blockNumber === before.blockNumber &&
        after.blockHash !== before.blockHash) ||
      permissionPlan(after, fresh, wallet, deps.sameWallet).length
    )
      throw new Error("Staking permissions are not finalized yet.");
    clear();
    return from;
  };
  const performRegister = async (
    reviewed: Review,
    from: Anchor,
  ): Promise<SessionStatus> => {
    requireNoPending();
    await capability("memberships:manage");
    const fresh = await checkReview(reviewed);
    const current = await status();
    if (current.membership?.current === "unknown")
      throw new Error("Membership could not be verified.");
    if (
      active(current) &&
      fresh.initialAllocation?.status !== "repair_required"
    )
      return current;
    if (!chain) throw new Error("Read finalized permissions before joining.");
    const permissions = await chain.readPermissions(fresh, wallet);
    guard();
    if (permissionPlan(permissions, fresh, wallet, deps.sameWallet).length)
      throw new Error("Complete staking permissions first.");
    let birth = anchor(from);
    if (fresh.initialAllocation?.status === "repair_required") {
      const repair = fresh.initialAllocationRepair;
      if (!repair || Date.parse(repair.expiresAt) <= deps.now())
        throw new Error("Complete Setup confirmation expired.");
      birth = anchor(repair);
    }
    if (
      fresh.membershipSharingAvailable &&
      fresh.membershipSharingScope !== "partner_membership"
    )
      throw new Error("Unsupported membership visibility scope.");
    const data = {
      ...birth,
      membershipSharing: fresh.membershipSharingAvailable
        ? "partner_membership"
        : "none",
      ...(reviewed.feeTermsHash ? { feeTermsHash: reviewed.feeTermsHash } : {}),
    };
    const raw = record(
      await signSessionAction(
        id,
        access.actionToken,
        "register",
        data,
        wallet,
        {
          ...deps,
          request: async (path, token, body) => {
            if (path.endsWith("/register")) mark("register", birth);
            return http.partner(path, token, body);
          },
        },
        fresh,
      ),
    );
    const result = parseStatus(raw);
    guard();
    if (
      result.sessionId !== id ||
      result.strategyRef !== fresh.strategyRef ||
      result.membership?.registration !== "accepted" ||
      !active(result) ||
      (result.membership.walletAddress &&
        !deps.sameWallet(
          result.membership.walletAddress,
          wallet.managedWalletAddress,
        ))
    )
      throw new Error("Membership acceptance needs reconciliation.");
    if (raw.context !== undefined || fresh.walletVerified === false)
      acceptBound(raw);
    await refresh();
    clear();
    return result;
  };
  return {
    review,
    /** A separate wallet identity proof for returning members. It grants no trading permission. */
    verifyWallet: () =>
      run("wallet-proof", async () => {
        guard();
        await refresh();
        const raw = record(
          await signSessionAction(
            id,
            access.actionToken,
            "wallet-proof",
            { discloseMembership: false },
            wallet,
            { ...deps, request: http.partner },
          ),
        );
        acceptBound(raw);
        return status();
      }),
    ensurePermissions: (reviewed: Review) =>
      run(`permissions:${canonical(reviewed)}`, () =>
        performPermissions(reviewed),
      ),
    register: (reviewed: Review, from: Anchor) =>
      run(`register:${canonical([reviewed, from])}`, () =>
        performRegister(reviewed, from),
      ),
    /** Existing-member setup uses the server's original membership anchor; never leave/rejoin. */
    completeSetup: (reviewed: Review) =>
      run(`setup:${canonical(reviewed)}`, async () => {
        requireNoPending();
        const fresh = await checkReview(reviewed);
        if (!active(await status()))
          throw new Error("No existing membership to repair.");
        if (
          fresh.initialAllocation?.status === "existing" ||
          fresh.initialAllocation?.status === "ready"
        )
          return fresh;
        const from = await performPermissions(reviewed);
        // Repair confirmation uses the authoritative original birth anchor in performRegister.
        await performRegister(reviewed, from);
        return refresh();
      }),
    /** Re-read server and finalized chain evidence. Never infer acceptance from a checkpoint. */
    reconcile: () =>
      run("reconcile", async (): Promise<Snapshot> => {
        const fresh = await refresh();
        const current = await status();
        const p = pending();
        if (
          p?.kind === "register" &&
          active(current) &&
          fresh.walletVerified !== false &&
          fresh.initialAllocation?.status !== "repair_required"
        )
          clear();
        if (
          p?.kind === "allocation" &&
          fresh.initialAllocation?.status === "existing" &&
          (!p.requestId ||
            fresh.initialAllocation.job.correlationId === p.requestId)
        )
          clear();
        if (p?.kind === "permissions" && chain) {
          const permissions = await chain.readPermissions(fresh, wallet);
          guard();
          if (
            !permissionPlan(permissions, fresh, wallet, deps.sameWallet).length
          )
            clear();
        }
        return {
          context: fresh,
          status: current,
          pending: pending()?.kind ?? null,
        };
      }),
    /** Requires its OWN explicit approval. Membership alone never starts trading. */
    allocate: (approved: true) =>
      run("allocation", async () => {
        if (approved !== true)
          throw new Error("Initial rebalance approval required.");
        requireNoPending();
        await capability("initial-allocation:request");
        const fresh = await refresh();
        if (
          fresh.walletVerified === false ||
          (await status()).membership?.current !== "active"
        )
          throw new Error("Verify existing membership first.");
        if (fresh.initialAllocation?.status === "existing")
          return fresh.initialAllocation.job;
        if (fresh.initialAllocation?.status !== "ready")
          throw new Error(
            "Complete Setup before requesting the initial rebalance.",
          );
        const result = await requestInitialAllocation(
          {
            ...wallet,
            strategyId: fresh.strategyId,
            strategyTable: fresh.strategyTable,
            partnerSessionId: id,
          },
          {
            ...deps,
            request: async (path, init) => {
              if (path === "") mark("allocation");
              return http.allocation(path, init);
            },
          },
        );
        guard();
        deps.storage.setItem(allocationKey, JSON.stringify(result));
        clear();
        return result.job;
      }),
    /** Explicit renewal of a fresh server-confirmed, expired and never-started job only. */
    renewAllocation: (approved: true) =>
      run("allocation-renewal", async () => {
        if (approved !== true) throw new Error("Renewal approval required.");
        requireNoPending();
        await capability("initial-allocation:request");
        const fresh = await refresh();
        if (
          fresh.walletVerified === false ||
          (await status()).membership?.current !== "active"
        )
          throw new Error("Verify existing membership first.");
        if (
          fresh.initialAllocation?.status !== "existing" ||
          !canRenewInitialAllocation(fresh.initialAllocation.job)
        )
          throw new Error(
            "Only an expired initial rebalance that never started can be renewed.",
          );
        const result = await requestInitialAllocation(
          {
            ...wallet,
            strategyId: fresh.strategyId,
            strategyTable: fresh.strategyTable,
            partnerSessionId: id,
            renewCorrelationId: fresh.initialAllocation.job.correlationId,
          },
          {
            ...deps,
            request: async (path, init) => {
              if (path === "")
                mark(
                  "allocation",
                  undefined,
                  new Headers(init.headers).get("x-correlation-id") ??
                    undefined,
                );
              return http.allocation(path, init);
            },
          },
        );
        guard();
        deps.storage.setItem(allocationKey, JSON.stringify(result));
        clear();
        return result.job;
      }),
    allocationStatus: async () => {
      const fresh = await refresh();
      if (fresh.walletVerified === false)
        throw new Error("Verify this membership first.");
      const stored = deps.storage.getItem(allocationKey);
      if (!stored) {
        if (fresh.initialAllocation?.status === "existing")
          return fresh.initialAllocation.job;
        throw new Error("No recorded initial rebalance.");
      }
      const storedValue = record(JSON.parse(stored));
      // Fresh authenticated context can recover an expired read token or a lost renewal response.
      // It never creates action access or authorizes another request.
      if (
        fresh.initialAllocation?.status === "existing" &&
        (Date.parse(String(storedValue.readExpiresAt)) <= deps.now() ||
          record(storedValue.job).correlationId !==
            fresh.initialAllocation.job.correlationId)
      )
        return fresh.initialAllocation.job;
      const allocation: InitialAllocationAccess = parseInitialAllocationAccess(
        storedValue,
        deps.now,
      );
      if (
        fresh.initialAllocation?.status !== "existing" ||
        fresh.initialAllocation.job.jobId !== allocation.job.jobId ||
        fresh.initialAllocation.job.correlationId !==
          allocation.job.correlationId
      )
        throw new Error(
          "Stored allocation changed membership. Reconcile its status.",
        );
      guard();
      const job = await fetchInitialAllocation(allocation, {
        ...deps,
        request: http.allocation,
      });
      guard();
      return job;
    },
    continuation: async () =>
      parseLaunch(
        await http.partner(
          `join-sessions/${id}/continuation`,
          access.actionToken,
          {},
        ),
      ),
  };
}
