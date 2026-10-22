// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createPartnerClient,
  type Dependencies,
  type JoinContext,
  type Wallet,
} from "../src/browser";
import { signSessionAction, canonical } from "../src/signing";
import { stringToHex } from "../src/encoding";
import {
  INITIAL_ALLOCATION_CONSENT,
  INITIAL_ALLOCATION_RENEWAL_CONSENT,
  requestInitialAllocation,
  parseInitialAllocationReceipt,
} from "../src/allocation";
import { createServerBridge } from "../src/server";
import { boundedJson } from "../src/transport";
import { permissionPlan, type ChainAdapter } from "../src/chain";
const id = "11111111-1111-4111-8111-111111111111",
  partner = "22222222-2222-4222-8222-222222222222",
  strategy = "33333333-3333-4333-8333-333333333333";
const challengeId = "44444444-4444-4444-8444-444444444444";
const address = "5" + "A".repeat(47),
  proxy = "5" + "B".repeat(47),
  hash = "0x" + "12".repeat(32),
  token = "a".repeat(48);
const time = Date.parse("2026-10-09T20:00:00.000Z"),
  expiry = new Date(time + 300_000).toISOString();
const sha256 = async (s: string) =>
  createHash("sha256").update(s).digest("hex");
const wallet = (): Wallet => ({
  signer: {
    signRaw: vi.fn(async () => ({ signature: "0x" + "ab".repeat(64) })),
  },
  signerAddress: address,
  managedWalletAddress: address,
  genesisHash: hash,
  assertCurrentFlow: vi.fn(),
});
function context(): JoinContext {
  return {
    sessionId: id,
    partnerId: partner,
    partnerName: "Test partner",
    strategyRef: "Agentic",
    strategyId: strategy,
    strategyTable: "strategies",
    proxy,
    network: "finney",
    genesisHash: hash,
    name: "Agentic",
    description: "Demo",
    accessMode: "public",
    availability: "joinable",
    feeTermsHash: null,
    managedWalletAddress: address,
    signerAddress: address,
    walletVerified: true,
    membershipSharingAvailable: false,
    initialAllocation: { status: "ready" },
    returnUrl: "https://partner.example/return",
    allowedOrigins: ["https://partner.example"],
    expiresAt: expiry,
    ownerWalletAddress: null,
    feePolicy: {
      strategyId: strategy,
      feeEnabled: false,
      currentPolicy: null,
      scheduledPolicy: null,
      disclosure: null,
    },
  };
}
const access = () => ({
  sessionId: id,
  actionToken: token,
  observerToken: token,
  expiresAt: expiry,
});
const status = (member = false) => ({
  sessionId: id,
  strategyRef: "Agentic",
  status: member ? "membership_accepted" : "open",
  membership: {
    registration: member ? "accepted" : "pending",
    current: member ? "active" : "not_member",
    acceptedAt: member ? new Date(time).toISOString() : null,
    asOf: new Date(time).toISOString(),
    walletAddress: address,
  },
  allocation: { status: "unknown" },
  checkpoint: null,
  checkpoints: [],
  nextAction: member ? "manage" : "resume",
  expiresAt: expiry,
  receiptExpiresAt: null,
});
async function challenge(action: string, data: unknown, ctx?: JoinContext) {
  const payload = {
    domain: "trustedstake:partner-join",
    version: 1,
    action,
    method: "POST",
    path: `/api/v1/partners/join-sessions/${id}/${action}`,
    sessionId: id,
    managedWalletAddress: address,
    signerAddress: address,
    network: "finney",
    genesisHash: hash,
    nonce: challengeId,
    expiresAt: expiry,
    bodyHash: "0x" + (await sha256(canonical(data))),
    data,
    ...(ctx
      ? {
          partnerId: partner,
          strategyRef: "Agentic",
          strategyId: strategy,
          strategyTable: "strategies",
        }
      : {}),
  };
  const message = JSON.stringify(payload);
  return {
    challengeId,
    message,
    signingBytes: stringToHex(message),
    expiresAt: expiry,
  };
}
function harness() {
  let ctx = context();
  let member = false;
  let ready = true;
  let loseRegistration = false;
  let losePermissions = false;
  let loseAllocation = false;
  const storage = new Map<string, string>();
  const w = wallet();
  const count = { register: 0, proxy: 0, allocation: 0 };
  const snapshot = () => ({
    genesisHash: hash,
    walletAddress: address,
    proxy,
    stakingProxy: ready,
    realPaysFee: ready,
    blockHash: hash,
    blockNumber: 100,
    timestamp: time,
  });
  const chain: ChainAdapter = {
    readPermissions: vi.fn(async () => snapshot()),
    submitPermissions: vi.fn(async () => {
      count.proxy++;
      ready = true;
      if (losePermissions) throw new Error("Response lost");
      return { transactionHash: hash, blockHash: hash };
    }),
  };
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path.endsWith("/frame-config"))
        return Response.json({
          partnerId: partner,
          partnerName: "Test partner",
          allowedOrigins: ["https://partner.example"],
          features: ["memberships:manage", "initial-allocation:request"],
        });
      if (path.endsWith("/exchange")) return Response.json(access());
      if (path.endsWith("/context")) return Response.json(ctx);
      if (path.endsWith("/challenges"))
        return Response.json(
          await challenge(
            body.action,
            body.data,
            body.action === "register" ? ctx : undefined,
          ),
        );
      if (path.endsWith("/wallet-proof"))
        return Response.json({
          context: ctx,
          actionToken: token,
          expiresAt: expiry,
        });
      if (path === "/rebalance/challenge") {
        const data = {
          version: 1,
          method: "POST",
          route: "/api/v1/membership/initial-allocation",
          bodyHash: await sha256("{}"),
          genesisHash: hash,
          expiresAt: Date.parse(expiry),
          requestId: challengeId,
          strategyId: strategy,
          strategyTable: "strategies",
          strategyHash: "ab".repeat(32),
          partnerSessionId: id,
          ...(body.renewCorrelationId
            ? { renewCorrelationId: body.renewCorrelationId }
            : {}),
          consent: body.renewCorrelationId
            ? INITIAL_ALLOCATION_RENEWAL_CONSENT
            : INITIAL_ALLOCATION_CONSENT,
        };
        return Response.json({
          message: JSON.stringify({
            action: "request_initial_allocation",
            nonce: challengeId,
            timestamp: time,
            signerAddress: address,
            managedWalletAddress: address,
            data,
          }),
          requestId: challengeId,
          expiresAt: expiry,
        });
      }
      if (path === "/rebalance") {
        count.allocation++;
        const job = {
          jobId: strategy,
          correlationId: challengeId,
          status: "queued" as const,
          reason: null,
          createdAt: new Date(time).toISOString(),
          startedAt: null,
          finishedAt: null,
          successfulOperations: 0,
          failedOperations: 0,
        };
        ctx = { ...ctx, initialAllocation: { status: "existing", job } };
        if (loseAllocation) throw new Error("Allocation response lost");
        return Response.json({ job, readToken: token, readExpiresAt: expiry });
      }
      if (path.endsWith("/register")) {
        count.register++;
        member = true;
        ctx = {
          ...ctx,
          walletVerified: true,
          managedWalletAddress: address,
          signerAddress: address,
          initialAllocation: { status: "ready" },
        };
        if (loseRegistration) throw new Error("Response lost");
        return Response.json({
          ...status(true),
          context: {
            ...ctx,
            walletVerified: true,
            managedWalletAddress: address,
            signerAddress: address,
          },
          actionToken: token,
          expiresAt: expiry,
        });
      }
      if (path === `/bridge/join-sessions/${id}`)
        return Response.json(status(member));
      throw new Error("Unexpected request: " + path);
    },
  ) as unknown as typeof fetch;
  const deps: Dependencies = {
    fetch: fetcher,
    baseUrl: "/bridge",
    allocationBaseUrl: "/rebalance",
    now: () => time,
    sha256,
    sameWallet: (a, b) => a === b,
    readable: false,
    storage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => {
        storage.set(k, v);
      },
      removeItem: (k) => {
        storage.delete(k);
      },
    },
  };
  const client = createPartnerClient(deps);
  return {
    deps,
    storage,
    w,
    chain,
    client,
    session: client.session(access(), w, chain),
    count,
    get ctx() {
      return ctx;
    },
    set ctx(value: JoinContext) {
      ctx = value;
    },
    set member(value: boolean) {
      member = value;
    },
    set ready(value: boolean) {
      ready = value;
    },
    set loseRegistration(value: boolean) {
      loseRegistration = value;
    },
    set loseAllocation(value: boolean) {
      loseAllocation = value;
    },
    set losePermissions(value: boolean) {
      losePermissions = value;
    },
  };
}
describe("exact wallet intents", () => {
  it.each([
    "path",
    "sessionId",
    "genesisHash",
    "signerAddress",
    "managedWalletAddress",
    "data",
    "bodyHash",
    "nonce",
  ])("rejects substituted %s before wallet signing", async (field) => {
    const w = wallet();
    const c = await challenge("wallet-proof", { discloseMembership: false });
    const envelope = JSON.parse(c.message);
    envelope[field] = field === "data" ? {} : "wrong";
    c.message = JSON.stringify(envelope);
    c.signingBytes = stringToHex(c.message);
    await expect(
      signSessionAction(
        id,
        token,
        "wallet-proof",
        { discloseMembership: false },
        w,
        {
          now: () => time,
          sha256,
          readable: false,
          sameWallet: (a, b) => a === b,
          request: async () => c,
        },
      ),
    ).rejects.toThrow();
    expect(w.signer.signRaw).not.toHaveBeenCalled();
  });
  it("signs exactly the readable challenge bytes and submits once", async () => {
    const w = wallet();
    const c = await challenge("wallet-proof", { discloseMembership: false });
    const payload = JSON.parse(c.message);
    const message = `TrustedStake - Verify membership | Request: ${challengeId}`;
    const req = vi.fn(async () => ({
      ...c,
      payload,
      message,
      signingBytes: stringToHex(message),
    }));
    await signSessionAction(
      id,
      token,
      "wallet-proof",
      { discloseMembership: false },
      w,
      {
        now: () => time,
        sha256,
        readable: true,
        sameWallet: (a, b) => a === b,
        request: req,
      },
    );
    expect(w.signer.signRaw).toHaveBeenCalledWith({
      address,
      type: "bytes",
      data: stringToHex(message),
    });
    expect(req).toHaveBeenCalledTimes(2);
  });
  it("rejects expiration while wallet popup is open", async () => {
    let now = time;
    const w = wallet();
    w.signer.signRaw = vi.fn(async () => {
      now += 360_000;
      return { signature: "0x" + "ab".repeat(64) };
    });
    const c = await challenge("wallet-proof", { discloseMembership: false });
    const req = vi.fn(async () => c);
    await expect(
      signSessionAction(
        id,
        token,
        "wallet-proof",
        { discloseMembership: false },
        w,
        {
          now: () => now,
          sha256,
          readable: false,
          sameWallet: (a, b) => a === b,
          request: req,
        },
      ),
    ).rejects.toThrow("expired");
    expect(req).toHaveBeenCalledTimes(1);
  });
  it("does not submit after a rejected signature or changed account", async () => {
    const c = await challenge("wallet-proof", { discloseMembership: false });
    const req = vi.fn(async () => c);
    const w = wallet();
    w.signer.signRaw = vi.fn(async () => {
      throw new Error("User rejected");
    });
    await expect(
      signSessionAction(
        id,
        token,
        "wallet-proof",
        { discloseMembership: false },
        w,
        {
          now: () => time,
          sha256,
          readable: false,
          sameWallet: (a, b) => a === b,
          request: req,
        },
      ),
    ).rejects.toThrow("rejected");
    expect(req).toHaveBeenCalledTimes(1);
    let changed = false;
    w.assertCurrentFlow = () => {
      if (changed) throw new Error("Account changed");
    };
    w.signer.signRaw = async () => {
      changed = true;
      return { signature: "0x" + "ab".repeat(64) };
    };
    await expect(
      signSessionAction(
        id,
        token,
        "wallet-proof",
        { discloseMembership: false },
        w,
        {
          now: () => time,
          sha256,
          readable: false,
          sameWallet: (a, b) => a === b,
          request: req,
        },
      ),
    ).rejects.toThrow("Account changed");
    expect(req).toHaveBeenCalledTimes(2);
  });
});
describe("join and Complete Setup", () => {
  it("deduplicates repeated registration clicks and detects membership after navigation", async () => {
    const h = harness();
    const reviewed = await h.session.review();
    const birth = { fromBlock: 100, fromTimestamp: time };
    await Promise.all([
      h.session.register(reviewed, birth),
      h.session.register(reviewed, birth),
    ]);
    expect(h.count.register).toBe(1);
    const again = h.client.session(access(), h.w, h.chain);
    await again.register(await again.review(), birth);
    expect(h.count.register).toBe(1);
  });
  it("uses existing Staking permissions without duplicate addProxy", async () => {
    const h = harness();
    await h.session.ensurePermissions(await h.session.review());
    expect(h.count.proxy).toBe(0);
    h.ready = false;
    await h.session.ensurePermissions(await h.session.review());
    expect(h.count.proxy).toBe(1);
    await h.session.ensurePermissions(await h.session.review());
    expect(h.count.proxy).toBe(1);
  });
  it("survives interrupted permission submission and reconciles before another transaction", async () => {
    const h = harness();
    h.ready = false;
    h.losePermissions = true;
    const reviewed = await h.session.review();
    await expect(h.session.ensurePermissions(reviewed)).rejects.toThrow("lost");
    const restored = h.client.session(access(), h.w, h.chain);
    await expect(restored.ensurePermissions(reviewed)).rejects.toThrow(
      "reconciliation",
    );
    expect(h.count.proxy).toBe(1);
    expect((await restored.reconcile()).pending).toBeNull();
    await restored.ensurePermissions(reviewed);
    expect(h.count.proxy).toBe(1);
  });
  it("does not replay registration after losing its accepted response", async () => {
    const h = harness();
    h.loseRegistration = true;
    const reviewed = await h.session.review();
    const birth = { fromBlock: 100, fromTimestamp: time };
    await expect(h.session.register(reviewed, birth)).rejects.toThrow("lost");
    const restored = h.client.session(access(), h.w, h.chain);
    await expect(restored.register(reviewed, birth)).rejects.toThrow(
      "reconciliation",
    );
    expect(h.count.register).toBe(1);
    expect((await restored.reconcile()).pending).toBeNull();
    await restored.register(reviewed, birth);
    expect(h.count.register).toBe(1);
  });
  it("repairs an existing membership using the server birth anchor, without leaving/rejoining", async () => {
    const h = harness();
    h.member = true;
    h.ctx = {
      ...h.ctx,
      initialAllocation: { status: "repair_required" },
      initialAllocationRepair: {
        fromBlock: 71,
        fromTimestamp: time - 1000,
        expiresAt: expiry,
      },
    };
    await h.session.completeSetup(await h.session.review());
    const challengeCall = vi
      .mocked(h.deps.fetch)
      .mock.calls.find(([url]) => String(url).endsWith("/challenges"));
    expect(JSON.parse(String(challengeCall?.[1]?.body)).data).toMatchObject({
      fromBlock: 71,
      fromTimestamp: time - 1000,
    });
    expect(h.count.register).toBe(1);
    expect(h.count.proxy).toBe(0);
  });
  it("blocks changed fees, account/network/resource changes, stale capability and corrupted journals", async () => {
    const h = harness();
    const reviewed = await h.session.review();
    h.ctx = { ...h.ctx, feeTermsHash: "0x" + "ab".repeat(32) };
    await expect(
      h.session.register(reviewed, { fromBlock: 100, fromTimestamp: time }),
    ).rejects.toThrow("disagree");
    expect(h.w.signer.signRaw).not.toHaveBeenCalled();
    h.ctx = context();
    h.w.genesisHash = "0x" + "34".repeat(32);
    await expect(h.session.review()).rejects.toThrow("changed");
    h.w.genesisHash = hash;
    h.ctx = { ...context(), strategyId: partner };
    await expect(h.session.review()).rejects.toThrow("strategy");
    h.ctx = context();
    h.storage.set(
      `trustedstake:sdk:v1:pending:${id}`,
      JSON.stringify({
        version: 1,
        sessionId: id,
        signer: proxy,
        wallet: address,
        genesis: hash,
        strategyId: strategy,
        kind: "register",
      }),
    );
    await expect(
      h.session.register(reviewed, { fromBlock: 100, fromTimestamp: time }),
    ).rejects.toThrow("another wallet");
  });
  it("requires chain evidence and never enables rebalance from membership alone", async () => {
    const h = harness();
    const session = h.client.session(access(), h.w);
    await expect(
      session.register(await session.review(), {
        fromBlock: 100,
        fromTimestamp: time,
      }),
    ).rejects.toThrow("finalized permissions");
    await expect(session.allocate(true)).rejects.toThrow("membership");
    h.member = true;
    h.ctx = {
      ...h.ctx,
      initialAllocation: { status: "confirmation_required" },
    };
    await expect(session.allocate(true)).rejects.toThrow("Complete Setup");
  });
  it("persists a lost allocation acceptance and never submits a replacement after recovery", async () => {
    const h = harness();
    h.member = true;
    h.loseAllocation = true;
    await expect(h.session.allocate(true)).rejects.toThrow("lost");
    const restored = h.client.session(access(), h.w, h.chain);
    await expect(restored.allocate(true)).rejects.toThrow("reconciliation");
    expect((await restored.reconcile()).pending).toBeNull();
    expect((await restored.allocate(true)).status).toBe("queued");
    expect(h.count.allocation).toBe(1);
    expect(h.w.signer.signRaw).toHaveBeenCalledTimes(1);
  });
  it("fails closed on missing capabilities, expired access and storage failure before submit", async () => {
    const h = harness();
    const original = h.deps.fetch;
    h.deps.fetch = (async (url, init) =>
      String(url).endsWith("/frame-config")
        ? Response.json({
            partnerId: partner,
            partnerName: "Test partner",
            allowedOrigins: [],
            features: [],
          })
        : original(url, init)) as typeof fetch;
    const client = createPartnerClient(h.deps);
    const session = client.session(access(), h.w, h.chain);
    await expect(
      session.ensurePermissions(await session.review()),
    ).rejects.toThrow("capability");
    expect(h.count.proxy).toBe(0);
    h.deps.fetch = original;
    h.deps.now = () => time + 360000;
    await expect(h.session.review()).rejects.toThrow("session changed");
    h.deps.now = () => time;
    h.deps.storage.setItem = () => {
      throw new Error("Storage unavailable");
    };
    await expect(
      h.session.register(await h.session.review(), {
        fromBlock: 100,
        fromTimestamp: time,
      }),
    ).rejects.toThrow("Storage unavailable");
    expect(h.count.register).toBe(0);
  });
  it("binds rotated public-join access and rejects a substituted accepted context", async () => {
    const h = harness();
    h.ctx = {
      ...h.ctx,
      walletVerified: false,
      initialAllocation: undefined,
      managedWalletAddress: null,
      signerAddress: null,
    };
    await h.session.register(await h.session.review(), {
      fromBlock: 100,
      fromTimestamp: time,
    });
    expect(h.storage.has(`trustedstake:sdk:v1:access:${id}`)).toBe(true);
    const tampered = harness();
    const original = tampered.deps.fetch;
    tampered.deps.fetch = (async (url, init) => {
      const response = await original(url, init);
      if (!String(url).endsWith("/register")) return response;
      const raw = await response.json();
      raw.context.strategyId = partner;
      return Response.json(raw);
    }) as typeof fetch;
    const session = createPartnerClient(tampered.deps).session(
      access(),
      tampered.w,
      tampered.chain,
    );
    await expect(
      session.register(await session.review(), {
        fromBlock: 100,
        fromTimestamp: time,
      }),
    ).rejects.toThrow("strategy");
    expect(tampered.storage.has(`trustedstake:sdk:v1:access:${id}`)).toBe(
      false,
    );
  });
  it("returns existing queued job without submitting another allocation", async () => {
    const h = harness();
    h.member = true;
    h.ctx = {
      ...h.ctx,
      initialAllocation: {
        status: "existing",
        job: {
          jobId: strategy,
          correlationId: challengeId,
          status: "queued",
          reason: null,
          createdAt: new Date(time).toISOString(),
          startedAt: null,
          finishedAt: null,
          successfulOperations: 0,
          failedOperations: 0,
        },
      },
    };
    const job = await h.session.allocate(true);
    expect(job.status).toBe("queued");
    expect(h.w.signer.signRaw).not.toHaveBeenCalled();
  });
  it("refuses unverified or regressing permission evidence", () => {
    const h = harness();
    expect(() =>
      permissionPlan(
        {
          genesisHash: hash,
          walletAddress: proxy,
          proxy,
          stakingProxy: true,
          realPaysFee: true,
          blockHash: hash,
          blockNumber: 100,
          timestamp: time,
        },
        h.ctx,
        h.w,
        (a, b) => a === b,
      ),
    ).toThrow("Unverified");
  });
});
describe("separate durable allocation authorization", () => {
  it("signs an exact separate allocation request and rejects substitutions", async () => {
    const w = wallet();
    const data = {
      version: 1,
      method: "POST",
      route: "/api/v1/membership/initial-allocation",
      bodyHash: await sha256("{}"),
      genesisHash: hash,
      expiresAt: Date.parse(expiry),
      requestId: challengeId,
      strategyId: strategy,
      strategyTable: "strategies",
      strategyHash: "ab".repeat(32),
      partnerSessionId: id,
      consent: INITIAL_ALLOCATION_CONSENT,
    };
    const envelope = {
      action: "request_initial_allocation",
      nonce: challengeId,
      timestamp: time,
      signerAddress: address,
      managedWalletAddress: address,
      data,
    };
    const c = {
      message: JSON.stringify(envelope),
      requestId: challengeId,
      expiresAt: expiry,
    };
    const job = {
      jobId: strategy,
      correlationId: challengeId,
      status: "queued",
      reason: null,
      createdAt: new Date(time).toISOString(),
      startedAt: null,
      finishedAt: null,
      successfulOperations: 0,
      failedOperations: 0,
    };
    const req = vi.fn(async (path) =>
      path === "/challenge"
        ? c
        : { job, readToken: token, readExpiresAt: expiry },
    );
    const input = {
      ...w,
      strategyId: strategy,
      strategyTable: "strategies" as const,
      partnerSessionId: id,
    };
    const deps = {
      now: () => time,
      sha256,
      sameWallet: (a: string, b: string) => a === b,
      readable: false,
      request: req,
    };
    expect((await requestInitialAllocation(input, deps)).job.status).toBe(
      "queued",
    );
    expect(req.mock.calls[1][0]).toBe("");
    data.partnerSessionId = partner;
    c.message = JSON.stringify(envelope);
    await expect(requestInitialAllocation(input, deps)).rejects.toThrow(
      "did not match",
    );
    expect(w.signer.signRaw).toHaveBeenCalledTimes(1);
    expect(() =>
      parseInitialAllocationReceipt({ ...job, status: "completed" }),
    ).toThrow("inconsistent");
  });
});
describe("bounded server bridge", () => {
  it("forwards only allowlisted routes, uses server Bearer for allocation, and never leaks its key", async () => {
    const upstream = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ ok: true }),
    );
    const secret = "tsp_" + "s".repeat(40);
    const bridge = createServerBridge({
      fetch: upstream as typeof fetch,
      apiOrigin: "https://api.example",
      partnerPrefix: "/bridge",
      allocationPrefix: "/rebalance",
      partnerCredential: async () => secret,
      authorize: async () => true,
    });
    expect(
      (
        await bridge(
          new Request(
            `https://partner.example/bridge/public/${partner}/strategies`,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      new Headers(upstream.mock.calls[0][1]?.headers).has("authorization"),
    ).toBe(false);
    expect(
      (
        await bridge(
          new Request("https://partner.example/rebalance/challenge", {
            method: "POST",
            body: JSON.stringify({
              walletAddress: address,
              signerAddress: address,
              strategyId: strategy,
              strategyTable: "strategies",
              partnerSessionId: id,
            }),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      new Headers(upstream.mock.calls[1][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${secret}`);
    expect(
      (await bridge(new Request("https://partner.example/bridge/admin/users")))
        .status,
    ).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(2);
    upstream.mockImplementation(async () =>
      Response.json({ credential: secret }),
    );
    expect(
      (
        await bridge(
          new Request("https://partner.example/rebalance/challenge", {
            method: "POST",
            body: JSON.stringify({
              walletAddress: address,
              signerAddress: address,
              strategyId: strategy,
              strategyTable: "strategies",
              partnerSessionId: id,
            }),
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("rejects browser server keys, unapproved requests and oversized streaming bodies", async () => {
    const upstream = vi.fn();
    const bridge = createServerBridge({
      fetch: upstream,
      apiOrigin: "https://api.example",
      partnerPrefix: "/bridge",
      allocationPrefix: "/rebalance",
      partnerCredential: async () => "tsp_" + "s".repeat(40),
      authorize: async () => false,
    });
    expect(
      (
        await bridge(
          new Request(
            `https://partner.example/bridge/public/${partner}/strategies`,
            { headers: { authorization: "Bearer tsp_" + "s".repeat(40) } },
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await bridge(
          new Request(
            `https://partner.example/bridge/public/${partner}/strategies`,
          ),
        )
      ).status,
    ).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    await expect(boundedJson(new Response("x".repeat(20)), 10)).rejects.toThrow(
      "limit",
    );
  });
});

function expiredJob() {
  return {
    jobId: strategy,
    correlationId: partner,
    status: "blocked" as const,
    reason: "authorization_expired",
    createdAt: new Date(time - 7200000).toISOString(),
    startedAt: null,
    finishedAt: new Date(time - 3600000).toISOString(),
    successfulOperations: 0,
    failedOperations: 0,
  };
}
describe("native allocation renewal", () => {
  it("requires explicit approval, signs fresh renewal consent and coalesces duplicate clicks", async () => {
    const h = harness();
    h.member = true;
    h.ctx = {
      ...h.ctx,
      initialAllocation: { status: "existing", job: expiredJob() },
    };
    await expect(h.session.renewAllocation(false as true)).rejects.toThrow(
      "approval",
    );
    expect(h.w.signer.signRaw).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([
      h.session.renewAllocation(true),
      h.session.renewAllocation(true),
    ]);
    expect(a.correlationId).toBe(challengeId);
    expect(b).toEqual(a);
    expect(h.count.allocation).toBe(1);
    const signed = vi.mocked(h.w.signer.signRaw!).mock.calls[0][0];
    const intent = JSON.parse(
      Buffer.from(signed.data.slice(2), "hex").toString(),
    );
    expect(intent.data.renewCorrelationId).toBe(partner);
    expect(intent.data.consent).toBe(INITIAL_ALLOCATION_RENEWAL_CONSENT);
  });
  it.each([
    { status: "needs_review" },
    { reason: "proxy_missing" },
    { startedAt: new Date(time - 5400000).toISOString() },
    { successfulOperations: 1 },
    { failedOperations: 1 },
  ])("never renews unsafe job %j", async (patch) => {
    const h = harness();
    h.member = true;
    h.ctx = {
      ...h.ctx,
      initialAllocation: {
        status: "existing",
        job: { ...expiredJob(), ...patch } as ReturnType<typeof expiredJob>,
      },
    };
    await expect(h.session.renewAllocation(true)).rejects.toThrow();
    expect(h.w.signer.signRaw).not.toHaveBeenCalled();
    expect(h.count.allocation).toBe(0);
  });
  it("does not mistake the old expired job for acceptance after a lost renewal response", async () => {
    const h = harness();
    h.member = true;
    h.loseAllocation = true;
    const old = {
      ...h.ctx,
      initialAllocation: { status: "existing" as const, job: expiredJob() },
    };
    h.ctx = old;
    await expect(h.session.renewAllocation(true)).rejects.toThrow();
    const accepted = h.ctx;
    h.ctx = old;
    expect((await h.session.reconcile()).pending).toBe("allocation");
    await expect(h.session.renewAllocation(true)).rejects.toThrow(
      "reconciliation",
    );
    h.ctx = accepted;
    expect((await h.session.reconcile()).pending).toBeNull();
    expect((await h.session.allocate(true)).correlationId).toBe(challengeId);
    expect(h.count.allocation).toBe(1);
  });
  it("rejects a substituted renewal identifier before signing", async () => {
    const h = harness();
    const request = vi.fn(async () => {
      const response = await h.deps.fetch("/rebalance/challenge", {
        body: JSON.stringify({ renewCorrelationId: strategy }),
      });
      return response.json();
    });
    await expect(
      requestInitialAllocation(
        {
          ...h.w,
          strategyId: strategy,
          strategyTable: "strategies",
          partnerSessionId: id,
          renewCorrelationId: partner,
        },
        { ...h.deps, request },
      ),
    ).rejects.toThrow("did not match");
    expect(h.w.signer.signRaw).not.toHaveBeenCalled();
  });
  it("allows only a valid renewal ID through the allocation bridge", async () => {
    const upstream = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json({ ok: true }),
    );
    const bridge = createServerBridge({
      fetch: upstream,
      apiOrigin: "https://api.example",
      partnerPrefix: "/bridge",
      allocationPrefix: "/rebalance",
      partnerCredential: async () => "tsp_" + "x".repeat(32),
      authorize: async () => true,
    });
    const body = {
      walletAddress: address,
      signerAddress: address,
      strategyId: strategy,
      strategyTable: "strategies",
      partnerSessionId: id,
      renewCorrelationId: partner,
    };
    const send = (value: unknown) =>
      bridge(
        new Request("https://partner.example/rebalance/challenge", {
          method: "POST",
          body: JSON.stringify(value),
        }),
      );
    expect((await send(body)).status).toBe(200);
    expect(
      JSON.parse(String(upstream.mock.calls[0][1]?.body)).renewCorrelationId,
    ).toBe(partner);
    expect((await send({ ...body, renewCorrelationId: "bad" })).status).toBe(
      400,
    );
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

it("signs exact readable renewal bytes and rejects consent substitution before signing", async () => {
  const h = harness();
  const legacy = await (
    await h.deps.fetch("/rebalance/challenge", {
      body: JSON.stringify({ renewCorrelationId: partner }),
    })
  ).json();
  const payload = JSON.parse(legacy.message);
  const message = `TrustedStake - Renew Initial Rebalance | Request: ${challengeId}`;
  const challenge = {
    ...legacy,
    message,
    schemaVersion: 2,
    payload,
    signingBytes: stringToHex(message),
    request: {
      method: "POST",
      path: "/api/v1/membership/initial-allocation",
      body: {},
    },
    walletAddress: address,
    signerAddress: address,
  };
  const request = vi.fn(async (path: string, init: RequestInit) => {
    if (path === "/challenge") return challenge;
    return (await h.deps.fetch("/rebalance", init)).json();
  });
  const input = {
    ...h.w,
    strategyId: strategy,
    strategyTable: "strategies" as const,
    partnerSessionId: id,
    renewCorrelationId: partner,
  };
  await requestInitialAllocation(input, { ...h.deps, readable: true, request });
  expect(vi.mocked(h.w.signer.signRaw!).mock.calls[0][0].data).toBe(
    stringToHex(message),
  );
  expect(new Headers(request.mock.calls[1][1].headers).get("x-message")).toBe(
    stringToHex(message),
  );
  payload.data.consent = INITIAL_ALLOCATION_CONSENT;
  await expect(
    requestInitialAllocation(input, { ...h.deps, readable: true, request }),
  ).rejects.toThrow("did not match");
  expect(h.w.signer.signRaw).toHaveBeenCalledTimes(1);
});
it("recovers status from authenticated context after a read token expires", async () => {
  const h = harness();
  h.member = true;
  const accepted = await h.session.allocate(true);
  const key = `trustedstake:sdk:v1:allocation:${id}`;
  const stored = JSON.parse(h.storage.get(key)!);
  stored.readExpiresAt = new Date(time - 1).toISOString();
  h.storage.set(key, JSON.stringify(stored));
  expect(await h.session.allocationStatus()).toEqual(accepted);
  expect(h.count.allocation).toBe(1);
});

it("reconciles a lost first approval using the membership ticket correlation", async () => {
  const h = harness();
  h.member = true;
  h.loseAllocation = true;
  await expect(h.session.allocate(true)).rejects.toThrow();
  if (h.ctx.initialAllocation?.status !== "existing")
    throw new Error("missing fixture job");
  h.ctx = {
    ...h.ctx,
    initialAllocation: {
      status: "existing",
      job: { ...h.ctx.initialAllocation.job, correlationId: partner },
    },
  };
  expect((await h.session.reconcile()).pending).toBeNull();
  expect((await h.session.allocate(true)).correlationId).toBe(partner);
  expect(h.count.allocation).toBe(1);
});

// Deterministic same-origin Web Locks model; a real two-page Chromium check supplements this.
function testLocks() {
  const held = new Set<string>();
  return {
    request: async (
      name: string,
      _options: unknown,
      callback: (lock: unknown) => unknown,
    ) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  } as unknown as Pick<LockManager, "request">;
}
it("coordinates two controllers and preserves a shared uncertain journal after lock release", async () => {
  const { createWebLocksCoordinator } = await import("../src/ownership");
  const h = harness();
  h.member = true;
  h.loseAllocation = true;
  const locks = testLocks();
  h.deps.coordinator = createWebLocksCoordinator(locks, id);
  // Tokens stay in independent stores; the public pending journal is shared.
  h.deps.journalStorage = h.deps.storage;
  const otherDeps = {
    ...h.deps,
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    coordinator: createWebLocksCoordinator(locks, id),
  };
  const other = createPartnerClient(otherDeps).session(access(), h.w, h.chain);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.mocked(h.w.signer.signRaw!).mockImplementationOnce(async () => {
    await gate;
    return { signature: "0x" + "ab".repeat(64) };
  });
  const first = h.session.allocate(true);
  await vi.waitFor(() => expect(h.w.signer.signRaw).toHaveBeenCalledTimes(1));
  await expect(other.allocate(true)).rejects.toThrow("Another tab");
  release();
  await expect(first).rejects.toThrow();
  await expect(other.allocate(true)).rejects.toThrow("reconciliation");
  expect((await other.reconcile()).pending).toBeNull();
  expect((await other.allocate(true)).status).toBe("queued");
  expect(h.count.allocation).toBe(1);
});
it("fails closed when cross-tab locking is unavailable", async () => {
  const { createWebLocksCoordinator } = await import("../src/ownership");
  expect(() => createWebLocksCoordinator(undefined as never, id)).toThrow(
    "Web Locks",
  );
});
