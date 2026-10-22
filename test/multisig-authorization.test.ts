import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createKeyMulti,
  cryptoWaitReady,
  encodeAddress,
} from "@polkadot/util-crypto";
import {
  exportAuthorizationProof,
  importAuthorizationProof as importProof,
  parseAuthorizationChallenge,
} from "../src/polkadot/multisig-authorization";
import type { PendingMultisigOp } from "../src/polkadot/types";
const hash = (c: string) => `0x${c.repeat(64)}`;
const signers = [1, 2].map((n) =>
  encodeAddress(new Uint8Array(32).fill(n), 42),
);
let op: PendingMultisigOp;
beforeAll(async () => {
  await cryptoWaitReady();
  const managed = encodeAddress(createKeyMulti(signers, 2), 42);
  op = {
    id: "membership-auth:550e8400-e29b-41d4-a716-446655440000",
    chainId: hash("a"),
    multisigAddress: managed,
    managedAccount: managed,
    currentSigner: signers[0],
    signatories: signers,
    sortedSignatories: signers,
    threshold: 2,
    callHashHex: hash("b"),
    callDataHex: "0x",
    operationKind: "other",
    operationLabel: "Authorization",
    status: "pending_approvals",
    timepoint: { height: 3, index: 2 },
    depositor: signers[0],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    authorizationProof: {
      challengeId: "550e8400-e29b-41d4-a716-446655440000",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    },
  };
});
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              genesisHash: op.chainId,
              challengeId: op.authorizationProof!.challengeId,
              challengeCallHash: op.callHashHex,
              managedWalletAddress: op.managedAccount,
              signerAddress: op.currentSigner,
              chainId: "finney",
              expiresAt: op.authorizationProof!.expiresAt,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());
function api(depositor = signers[0], index = 2, pending = true) {
  const snapshot = {
    genesisHash: { toHex: () => hash("a") },
    query: {
      multisig: {
        multisigs: async () =>
          pending
            ? {
                isNone: false,
                unwrap: () => ({
                  when: {
                    height: { toNumber: () => 3 },
                    index: { toNumber: () => index },
                  },
                  depositor,
                  approvals: { toJSON: () => [signers[0]] },
                }),
              }
            : { isNone: true },
      },
    },
  } as any;
  return {
    ...snapshot,
    rpc: { chain: { getFinalizedHead: async () => hash("f") } },
    at: async () => snapshot,
  };
}
describe("hash-only authorization recovery", () => {
  it("round trips public proof without importing authority or executable call bytes", async () => {
    const text = exportAuthorizationProof(op);
    expect(text).not.toContain("signature");
    expect(text).not.toContain("callData");
    const recovered = await importAuthorizationProof(api(), text, signers[0]);
    expect(recovered.callDataHex).toBe("0x");
    expect(recovered.status).toBe("needs_review");
    expect(recovered.authorizationProof).toEqual(op.authorizationProof);
  });
  it.each([
    (v: any) => {
      v.genesisHash = hash("c");
    },
    (v: any) => {
      v.signerAddress = signers[1];
    },
    (v: any) => {
      v.multisigAddress = signers[1];
    },
    (v: any) => {
      v.signatories = [signers[0], signers[0]];
    },
    (v: any) => {
      v.threshold = 1;
    },
    (v: any) => {
      v.signature = "forged";
    },
    (v: any) => {
      v.verified = true;
    },
    (v: any) => {
      v.timepoint.index = -1;
    },
    (v: any) => {
      v.timepoint.height = 0x100000000;
    },
    (v: any) => {
      v.callHash = hash("d");
    },
    (v: any) => {
      v.challengeId = "550e8400-e29b-41d4-a716-446655440099";
    },
  ])("rejects malformed or mismatched recovery context", async (mutate) => {
    const value = JSON.parse(exportAuthorizationProof(op));
    mutate(value);
    await expect(
      importAuthorizationProof(api(), JSON.stringify(value), signers[0]),
    ).rejects.toThrow();
  });
  it("rejects wrong connected signer, changed timepoint and depositor", async () => {
    await expect(
      importAuthorizationProof(api(), exportAuthorizationProof(op), signers[1]),
    ).rejects.toThrow();
    await expect(
      importAuthorizationProof(
        api(signers[0], 4),
        exportAuthorizationProof(op),
        signers[0],
      ),
    ).rejects.toThrow();
    await expect(
      importAuthorizationProof(
        api(signers[1]),
        exportAuthorizationProof(op),
        signers[0],
      ),
    ).rejects.toThrow();
  });
  it("rejects a server proof from a different genesis even when the local file matches its connected chain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              genesisHash: hash("d"),
              challengeId: op.authorizationProof!.challengeId,
              challengeCallHash: op.callHashHex,
              managedWalletAddress: op.managedAccount,
              signerAddress: op.currentSigner,
              chainId: "finney",
              expiresAt: op.authorizationProof!.expiresAt,
            },
          }),
        ),
      ),
    );
    await expect(
      importAuthorizationProof(api(), exportAuthorizationProof(op), signers[0]),
    ).rejects.toThrow("another network");
  });
  it("never treats missing storage as proof of refund or authorization", async () => {
    const result = await importAuthorizationProof(
      api(signers[0], 2, false),
      exportAuthorizationProof(op),
      signers[0],
    );
    expect(result.status).toBe("needs_review");
    expect(result.error).toContain("absence alone");
  });
  it("validates the backend challenge before any approval", () => {
    const challenge = {
      challengeId: op.authorizationProof!.challengeId,
      challengeCallHash: op.callHashHex,
      managedWalletAddress: op.managedAccount,
      signerAddress: signers[0],
      chainId: "finney",
      expiresAt: op.authorizationProof!.expiresAt,
      approveAsMultiTemplate: {},
    };
    expect(
      parseAuthorizationChallenge(challenge, op.managedAccount, signers[0])
        .callHash,
    ).toBe(op.callHashHex);
    expect(() =>
      parseAuthorizationChallenge(
        { ...challenge, signerAddress: signers[1] },
        op.managedAccount,
        signers[0],
      ),
    ).toThrow();
    expect(() =>
      parseAuthorizationChallenge(
        { ...challenge, expiresAt: new Date(0).toISOString() },
        op.managedAccount,
        signers[0],
      ),
    ).toThrow();
  });
});

function importAuthorizationProof(
  ...args: Parameters<typeof importProof> extends [...infer A, unknown]
    ? A
    : never
) {
  return importProof(...args, async (action, body) => {
    const response = await fetch(`/multisig/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("Authorization request failed");
    return response.json();
  });
}
