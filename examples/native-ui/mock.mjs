// Deterministic LOCAL demo. It never fetches a network resource or validates a real signature.
import {
  canonical,
  stringToHex,
  INITIAL_ALLOCATION_CONSENT,
  INITIAL_ALLOCATION_RENEWAL_CONSENT,
} from "../../dist/core.js";
export const sessionId = "11111111-1111-4111-8111-111111111111";
const partnerId = "22222222-2222-4222-8222-222222222222";
const strategyId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
export const address = "5" + "A".repeat(47),
  genesisHash = "0x" + "12".repeat(32),
  token = "a".repeat(48);
export const sha256 = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
export function mockService(repair = false, renewal = false) {
  const now = Date.now();
  const expiresAt = new Date(now + 300000).toISOString();
  let member = repair || renewal;
  let ready = true;
  let confirmed = !repair;
  let job = renewal
    ? {
        jobId: strategyId,
        correlationId: partnerId,
        status: "blocked",
        reason: "authorization_expired",
        createdAt: new Date(now - 7200000).toISOString(),
        startedAt: null,
        finishedAt: new Date(now - 3600000).toISOString(),
        successfulOperations: 0,
        failedOperations: 0,
      }
    : null;
  let polls = 0;
  const context = () => ({
    sessionId,
    partnerId,
    partnerName: "Demo partner",
    strategyRef: "agentic",
    strategyId,
    strategyTable: "strategies",
    proxy: "5" + "B".repeat(47),
    network: "finney",
    genesisHash,
    name: "Agentic",
    description: "Autonomous AI agent infrastructure exposure.",
    accessMode: "public",
    availability: "joinable",
    feeTermsHash: null,
    managedWalletAddress: address,
    signerAddress: address,
    walletVerified: true,
    membershipSharingAvailable: false,
    initialAllocation: job
      ? { status: "existing", job }
      : { status: confirmed ? "ready" : "repair_required" },
    ...(confirmed
      ? {}
      : {
          initialAllocationRepair: {
            fromBlock: 71,
            fromTimestamp: now - 1000,
            expiresAt,
          },
        }),
    returnUrl: "https://partner.example/strategies",
    allowedOrigins: ["https://partner.example"],
    expiresAt,
    ownerWalletAddress: null,
    feePolicy: {
      strategyId,
      feeEnabled: false,
      currentPolicy: null,
      scheduledPolicy: null,
      disclosure: null,
    },
  });
  const status = () => ({
    sessionId,
    strategyRef: "agentic",
    status: member ? "membership_accepted" : "open",
    membership: {
      registration: member ? "accepted" : "pending",
      current: member ? "active" : "not_member",
      acceptedAt: member ? new Date(now).toISOString() : null,
      asOf: new Date(now).toISOString(),
      walletAddress: address,
    },
    allocation: { status: "unknown" },
    checkpoint: null,
    checkpoints: [],
    nextAction: member ? "manage" : "resume",
    expiresAt,
    receiptExpiresAt: null,
  });
  return {
    chain: {
      readPermissions: async (ctx) => ({
        genesisHash,
        walletAddress: address,
        proxy: ctx.proxy,
        stakingProxy: ready,
        realPaysFee: ready,
        blockHash: genesisHash,
        blockNumber: 100,
        timestamp: now,
      }),
      submitPermissions: async () => {
        ready = true;
        return { transactionHash: genesisHash, blockHash: genesisHash };
      },
    },
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (url.endsWith("/exchange"))
        return Response.json({
          sessionId,
          actionToken: token,
          observerToken: token,
          expiresAt,
        });
      if (url.endsWith("/frame-config"))
        return Response.json({
          partnerId,
          partnerName: "Demo partner",
          allowedOrigins: ["https://partner.example"],
          features: ["memberships:manage", "initial-allocation:request"],
        });
      if (url.endsWith("/context")) return Response.json(context());
      if (url.endsWith("/challenges")) {
        const payload = {
          domain: "trustedstake:partner-join",
          version: 1,
          action: body.action,
          method: "POST",
          path: `/api/v1/partners/join-sessions/${sessionId}/${body.action}`,
          sessionId,
          managedWalletAddress: address,
          signerAddress: address,
          network: "finney",
          genesisHash,
          nonce: requestId,
          expiresAt,
          bodyHash: "0x" + (await sha256(canonical(body.data))),
          data: body.data,
          ...(body.action === "register"
            ? {
                partnerId,
                strategyRef: "agentic",
                strategyId,
                strategyTable: "strategies",
              }
            : {}),
        };
        const message = JSON.stringify(payload);
        return Response.json({
          challengeId: requestId,
          message,
          signingBytes: stringToHex(message),
          expiresAt,
        });
      }
      if (url.endsWith("/register")) {
        member = true;
        confirmed = true;
        return Response.json(status());
      }
      if (url.endsWith("/wallet-proof"))
        return Response.json({
          context: context(),
          actionToken: token,
          expiresAt,
        });
      if (url.endsWith("/challenge")) {
        const message = JSON.stringify({
          action: "request_initial_allocation",
          timestamp: now,
          nonce: requestId,
          signerAddress: address,
          managedWalletAddress: address,
          data: {
            version: 1,
            method: "POST",
            route: "/api/v1/membership/initial-allocation",
            bodyHash: await sha256("{}"),
            genesisHash,
            expiresAt: Date.parse(expiresAt),
            requestId,
            strategyId,
            strategyTable: "strategies",
            strategyHash: "ab".repeat(32),
            partnerSessionId: sessionId,
            ...(body.renewCorrelationId
              ? { renewCorrelationId: body.renewCorrelationId }
              : {}),
            consent: body.renewCorrelationId
              ? INITIAL_ALLOCATION_RENEWAL_CONSENT
              : INITIAL_ALLOCATION_CONSENT,
          },
        });
        return Response.json({ requestId, message, expiresAt });
      }
      if (url === "/rebalance") {
        job = {
          jobId: strategyId,
          correlationId: requestId,
          status: "queued",
          reason: null,
          createdAt: new Date(now).toISOString(),
          startedAt: null,
          finishedAt: null,
          successfulOperations: 0,
          failedOperations: 0,
        };
        return Response.json({
          job,
          readToken: token,
          readExpiresAt: expiresAt,
        });
      }
      if (url.startsWith("/rebalance/")) {
        polls++;
        job = {
          ...job,
          status: polls > 1 ? "completed" : "running",
          startedAt: new Date(now).toISOString(),
          finishedAt: polls > 1 ? new Date(now).toISOString() : null,
          successfulOperations: polls > 1 ? 1 : 0,
        };
        return Response.json(job);
      }
      if (url === `/bridge/join-sessions/${sessionId}`)
        return Response.json(status());
      throw new Error("No mock route: " + url);
    },
  };
}
