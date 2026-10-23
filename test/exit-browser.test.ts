import { createExitWalletSubmitter } from "../src/polkadot/exit-wallet.ts";
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  encodeAddress,
  createKeyMulti,
  blake2AsHex,
  decodeAddress,
  cryptoWaitReady,
  sr25519PairFromSeed,
  sr25519Sign,
  signatureVerify,
} from "@polkadot/util-crypto";
import { createNativeExitApi } from "../src/exit-api.ts";
import { createNativeExitBridge } from "../src/exit-bridge.ts";
import { createNativeExitController } from "../src/exit-browser.ts";
import { createPolkadotNativeExitAdapter } from "../src/polkadot/native-exit.ts";
import { canonical } from "../src/signing.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (n: string) => `0x${n.repeat(64)}`;
const sha = async (v: string) => createHash("sha256").update(v).digest("hex");
async function fixture(paid = false, multi = false) {
  await cryptoWaitReady();
  const pair = sr25519PairFromSeed(new Uint8Array(32).fill(101)),
    pair2 = sr25519PairFromSeed(new Uint8Array(32).fill(104)),
    signers = [
      encodeAddress(pair.publicKey, 42),
      encodeAddress(pair2.publicKey, 42),
    ],
    walletAddress = multi
      ? encodeAddress(createKeyMulti(signers, 2), 42)
      : signers[0],
    delegate = encodeAddress(new Uint8Array(32).fill(102), 42),
    hotkey = encodeAddress(new Uint8Array(32).fill(103), 42);
  const partnerId = id(1),
    strategyId = id(2),
    generation = id(3),
    genesis = hash("1");
  let activePair = pair;
  let now = 1700000000000,
    seq = 10,
    head = 100,
    proxy = true,
    stake = "1000000000",
    member = true,
    feeRequired = paid;
  let dependencies: unknown[] = [],
    stopFailure: "before" | "after" | undefined;
  const storageData = new Map<string, string>(),
    storage = {
      getItem: (k: string) => storageData.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storageData.set(k, v);
      },
      removeItem: (k: string) => {
        storageData.delete(k);
      },
    };
  const checkFlow = vi.fn(() => {}),
    signRaw = vi.fn(async ({ data }: { data: string }) => ({
      signature: `0x${Buffer.from(sr25519Sign(Buffer.from(data.slice(2), "hex"), activePair)).toString("hex")}`,
    }));
  const wallet = {
    signer: { signRaw },
    managedWalletAddress: walletAddress,
    signerAddress: signers[0],
    genesisHash: genesis,
    assertCurrentFlow: checkFlow,
  };
  const token = `tse_${id(4)}_${"a".repeat(64)}`;
  let proofMessage = "";
  const context = () => ({
    schemaVersion: 1,
    walletAddress,
    genesisHash: genesis,
    selection: {
      strategyId,
      strategyTable: "custom_strategies",
      proxy: delegate,
      expectedGeneration: generation,
    },
    membership: member ? "active" : "ended",
    canStopMembership: member,
    otherActiveMemberships: dependencies.length,
    otherProxyDependencies: dependencies,
    allocation: { state: "quiescent", unresolvedChainEffects: false, jobs: [] },
    checkedAt: new Date(now).toISOString(),
  });
  const checkout = () => ({
    required: feeRequired,
    bundleId: feeRequired ? id(5) : null,
    strategyId,
    memberSs58: walletAddress,
    network: feeRequired ? { name: "finney", genesisHash: genesis } : null,
    transfers: feeRequired ? [{ ss58: delegate, amountRao: "1000" }] : [],
    totalAmountRao: feeRequired ? "1000" : "0",
    paymentReferenceHash: feeRequired ? hash("b") : null,
    quoteExpiresAt: feeRequired ? new Date(now + 900000).toISOString() : null,
    reviewItems: [],
    extrinsicRecipe: feeRequired
      ? {
          kind: "BATCH_ALL_V1",
          calls: [
            {
              pallet: "balances",
              method: "transferKeepAlive",
              args: [delegate, "1000"],
            },
            { pallet: "system", method: "remarkWithEvent", args: [hash("b")] },
          ],
        }
      : null,
  });
  const upstream = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname,
        headers = new Headers(init?.headers),
        body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith("/connections/challenges")) {
        expect(body).toMatchObject({
          action: "read",
          purpose: "exit",
          managedWalletAddress: walletAddress,
          signerAddress: wallet.signerAddress,
        });
        const expiresAt = new Date(now + 300000).toISOString();
        proofMessage = canonical({
          domain: "trustedstake:partner-connection",
          version: 1,
          action: "read",
          method: "POST",
          path: `/api/v1/partners/public/${partnerId}/connections/read`,
          partnerId,
          partnerName: "Synthetic partner",
          connectionId: id(6),
          generation: 1,
          managedWalletAddress: walletAddress,
          signerAddress: wallet.signerAddress,
          network: "finney",
          genesisHash: genesis,
          nonce: id(7),
          expiresAt,
          bodyHash: `0x${await sha(canonical({ purpose: "exit" }))}`,
          data: { purpose: "exit" },
        });
        return Response.json({
          challengeId: id(4),
          message: proofMessage,
          signingBytes: `0x${Buffer.from(proofMessage).toString("hex")}`,
          expiresAt,
        });
      }
      if (path.endsWith("/connections/read")) {
        expect(
          signatureVerify(proofMessage, body.signature, wallet.signerAddress)
            .isValid,
        ).toBe(true);
        return Response.json({
          scope: "wallet_exit",
          connectionId: id(6),
          partnerId,
          walletAddress,
          managementToken: token,
          expiresAt: new Date(now + 900000).toISOString(),
        });
      }
      if (path.endsWith("/connections/exit-context")) {
        expect(headers.get("authorization")).toBe(`Bearer ${token}`);
        return Response.json(context());
      }
      const message = headers.get("x-message")!;
      expect(
        signatureVerify(
          message,
          headers.get("x-signature")!,
          wallet.signerAddress,
        ).isValid,
      ).toBe(true);
      const signed = JSON.parse(message);
      if (path.endsWith("/membership/unregister")) {
        expect(signed).toMatchObject({
          action: "unregister_membership",
          managedWalletAddress: walletAddress,
          data: {
            expectedGeneration: generation,
            genesisHash: genesis,
            proxy: delegate,
            strategyId,
          },
        });
        if (stopFailure === "before") {
          stopFailure = undefined;
          throw new Error("Connection lost before stop");
        }
        member = false;
        if (stopFailure === "after") {
          stopFailure = undefined;
          throw new Error("Connection lost after stop");
        }
        return Response.json({ success: true, data: { exit: context() } });
      }
      expect(signed.data).toMatchObject({
        route: path,
        method: "POST",
        walletAddress,
        genesisHash: genesis,
        bodyHash: `0x${await sha(canonical(body))}`,
      });
      if (path.endsWith("/exit-checkout"))
        return Response.json({ success: true, data: checkout() });
      if (path.endsWith("/bundles/" + id(5) + "/submitted")) {
        expect(body).toMatchObject({
          transactionHash: expect.any(String),
          blockNumber: head,
          extrinsicIndex: 0,
        });
        const acknowledged = checkout();
        feeRequired = false;
        return Response.json({ success: true, data: acknowledged });
      }
      return Response.json({ code: "UNEXPECTED_ROUTE" }, { status: 404 });
    },
  );
  const bridge = createNativeExitBridge({
    apiOrigin: "https://api.example",
    prefix: "/exit",
    fetch: upstream as typeof fetch,
    authorize: async () => true,
  });
  const api = createNativeExitApi({
    partnerId,
    wallet,
    request: async (path, init) => {
      const reply = await bridge(
        new Request(`https://partner.example/exit/${path}`, init),
      );
      if (!reply.ok) throw new Error(`Fixture API ${reply.status}`);
      return reply.json();
    },
    sameWallet: (a, b) =>
      Buffer.from(decodeAddress(a)).equals(Buffer.from(decodeAddress(b))),
    now: () => now,
    uuid: () => id(seq++),
    sha256: sha,
  });
  const codec = (v: unknown) => ({
    toJSON: () => v,
    toString: () => String(v),
    toNumber: () => Number(v),
  });
  const encoded = new Map<string, any>();
  const scalar = (v: any) => ({ toJSON: () => v, toString: () => String(v) });
  const sections: Record<string, string> = {
    removeProxy: "proxy",
    removeStake: "subtensorModule",
    removeStakeLimit: "subtensorModule",
    batchAll: "utility",
    transferKeepAlive: "balances",
    remarkWithEvent: "system",
    approveAsMulti: "multisig",
    asMulti: "multisig",
    cancelAsMulti: "multisig",
  };
  const tx =
    (name: string) =>
    (...args: any[]) => {
      const encode = (v: any): any =>
        Array.isArray(v)
          ? v.map(encode)
          : v?.method?.toHex
            ? v.method.toHex()
            : v;
      const hex = `0x${Buffer.from(JSON.stringify([name, args.map(encode)])).toString("hex")}`;
      const method = {
        section: sections[name],
        method: name,
        rawArgs: args,
        args: args.map((v) =>
          Array.isArray(v)
            ? v.map((x) => x?.method ?? scalar(x))
            : (v?.method ?? scalar(v)),
        ),
        toHex: () => hex,
        hash: { toHex: () => blake2AsHex(hex, 256) },
      };
      const call = {
        method,
        paymentInfo: async () => ({
          weight: { toJSON: () => ({ refTime: "1000", proofSize: "20" }) },
        }),
      };
      encoded.set(hex, call);
      return call;
    };
  const proposals = new Map<
    string,
    { height: number; index: number; approvals: string[]; depositor: string }
  >();
  const blocks = new Map<string, unknown>();
  const events = new Map<string, unknown>();
  const chainApi = {
    genesisHash: { toHex: () => genesis },
    runtimeVersion: { specVersion: codec(482), transactionVersion: codec(1) },
    rpc: {
      state: { getRuntimeVersion: async () => chainApi.runtimeVersion },
      chain: {
        getFinalizedHead: async () => ({
          toHex: () => `0x${head.toString(16).padStart(64, "0")}`,
        }),
        getHeader: async (h?: string) => ({
          number: {
            toNumber: () => (typeof h === "string" ? parseInt(h, 16) : head),
            toBigInt: () =>
              BigInt(typeof h === "string" ? parseInt(h, 16) : head),
            toString: () =>
              String(typeof h === "string" ? parseInt(h, 16) : head),
          },
        }),
        getBlockHash: async (n: string | number) => ({
          toHex: () => `0x${Number(n).toString(16).padStart(64, "0")}`,
        }),
        getBlock: async (h: string) => blocks.get(h),
      },
    },
    query: { system: { events: { at: async (h: string) => events.get(h) } } },
    at: async () => ({
      call: {
        stakeInfoRuntimeApi: {
          getStakeInfoForColdkey: async () =>
            codec([
              { coldkey: walletAddress, hotkey, netuid: 1, stake, locked: "0" },
            ]),
        },
        swapRuntimeApi: {
          currentAlphaPrice: async () => codec("1000000000"),
          simSwapAlphaForTao: async () =>
            codec({ alphaFee: "0", taoFee: "0", taoAmount: "990000000" }),
        },
      },
      query: {
        multisig: {
          multisigs: async (_wallet: string, callHash: string) => {
            const op = proposals.get(callHash);
            return op
              ? {
                  isNone: false,
                  unwrap: () => ({
                    when: { height: codec(op.height), index: codec(op.index) },
                    approvals: { toJSON: () => op.approvals },
                    depositor: { toString: () => op.depositor },
                  }),
                }
              : { isNone: true };
          },
        },
        proxy: {
          proxies: async () =>
            codec([
              proxy ? [{ delegate, proxyType: "Staking", delay: 0 }] : [],
              0,
            ]),
        },
        subtensorModule: { subtokenEnabled: async () => codec(true) },
      },
      consts: { subtensorModule: { initialMinStake: codec("100") } },
    }),
    tx: {
      proxy: { removeProxy: tx("removeProxy") },
      subtensorModule: {
        removeStakeLimit: tx("removeStakeLimit"),
        removeStake: tx("removeStake"),
      },
      utility: { batchAll: tx("batchAll") },
      balances: { transferKeepAlive: tx("transferKeepAlive") },
      system: { remarkWithEvent: tx("remarkWithEvent") },
    },
  };
  (chainApi as any).registry = {
    createType: (name: string, value: any) =>
      name === "Call" ? encoded.get(value).method : value,
  };
  chainApi.tx = Object.assign(
    ((call: any) => encoded.get(call.toHex())) as any,
    chainApi.tx,
    {
      multisig: {
        approveAsMulti: tx("approveAsMulti"),
        asMulti: tx("asMulti"),
        cancelAsMulti: tx("cancelAsMulti"),
      },
    },
  );
  const chain = createPolkadotNativeExitAdapter(chainApi as any, () => now);
  const controller = () =>
    createNativeExitController({
      api,
      chain,
      wallet,
      selection: {
        strategyId,
        strategyTable: "custom_strategies",
        proxy: delegate,
      },
      storage,
      coordinator: { run: async (f) => f() },
      ...(multi ? { multisig: { signatories: signers, threshold: 2 } } : {}),
      now: () => now,
      uuid: () => id(seq++),
      sha256: sha,
    });
  const submit = (effect: "proxy" | "stake" | "fee") =>
    vi.fn(
      async (
        transaction: unknown,
        assertCurrent: () => Promise<void>,
        onSigned: (hash: string) => void,
      ) => {
        await assertCurrent();
        const t = transaction as any,
          txHash = `0x${createHash("sha256").update(`${t.method.toHex()}:${head}:${wallet.signerAddress}`).digest("hex")}`;
        onSigned(txHash);
        head++;
        const blockHash = `0x${head.toString(16).padStart(64, "0")}`;
        blocks.set(blockHash, {
          block: {
            extrinsics: [
              {
                isSigned: true,
                signer: { toString: () => wallet.signerAddress },
                hash: { toHex: () => txHash },
                method: t.method,
              },
            ],
          },
        });
        const scoped: any[] = [
          {
            event: { section: "system", method: "ExtrinsicSuccess", data: [] },
          },
        ];
        let executed = true;
        if (t.method.method === "approveAsMulti") {
          executed = false;
          const callHash = String(t.method.args[3]);
          let op = proposals.get(callHash);
          if (!op) {
            op = {
              height: head,
              index: 0,
              approvals: [wallet.signerAddress],
              depositor: wallet.signerAddress,
            };
            proposals.set(callHash, op);
            scoped.push({
              event: {
                section: "multisig",
                method: "NewMultisig",
                data: [
                  scalar(wallet.signerAddress),
                  scalar(walletAddress),
                  scalar(callHash),
                ],
              },
            });
          } else {
            op.approvals.push(wallet.signerAddress);
            scoped.push({
              event: {
                section: "multisig",
                method: "MultisigApproval",
                data: [
                  scalar(wallet.signerAddress),
                  scalar({ height: op.height, index: op.index }),
                  scalar(walletAddress),
                  scalar(callHash),
                ],
              },
            });
          }
        } else if (t.method.method === "cancelAsMulti") {
          executed = false;
          const callHash = String(t.method.args[3]),
            op = proposals.get(callHash)!;
          proposals.delete(callHash);
          scoped.push({
            event: {
              section: "multisig",
              method: "MultisigCancelled",
              data: [
                scalar(wallet.signerAddress),
                scalar({ height: op.height, index: op.index }),
                scalar(walletAddress),
                scalar(callHash),
              ],
            },
          });
        } else if (t.method.method === "asMulti") {
          const inner = t.method.rawArgs[3],
            callHash = inner.method.hash.toHex(),
            op = proposals.get(callHash)!;
          proposals.delete(callHash);
          scoped.push({
            event: {
              section: "multisig",
              method: "MultisigExecuted",
              data: [
                scalar(wallet.signerAddress),
                scalar({ height: op.height, index: op.index }),
                scalar(walletAddress),
                scalar(callHash),
                { ...scalar({ ok: null }), isOk: true, isErr: false },
              ],
            },
          });
        }
        events.set(
          blockHash,
          scoped.map((e) => ({
            ...e,
            phase: {
              isApplyExtrinsic: true,
              asApplyExtrinsic: { toNumber: () => 0 },
            },
          })),
        );
        if (executed && effect === "proxy") proxy = false;
        if (executed && effect === "stake") stake = "0";
        return { transactionHash: txHash, blockHash };
      },
    );
  return {
    controller,
    api,
    chain,
    wallet,
    submit,
    storage,
    upstream,
    hotkey,
    checkFlow,
    signRaw,
    connectFirstSigner: () => {
      activePair = pair;
      wallet.signerAddress = signers[0];
    },
    connectSecondSigner: () => {
      activePair = pair2;
      wallet.signerAddress = signers[1];
    },
    setDependencies: (value: unknown[]) => {
      dependencies = value;
    },
    failStop: (value: "before" | "after") => {
      stopFailure = value;
    },
    setStake: (n: string) => {
      stake = n;
    },
    setProxy: (p: boolean) => {
      proxy = p;
    },
    setTime: (n: number) => {
      now = n;
    },
  };
}
describe("Partner browser + exit bridge + API contract + concrete chain adapter (synthetic service/chain)", () => {
  it("composes membership cessation, authority revocation and optional protected conversion, without external transfer", async () => {
    const f = await fixture(),
      client = f.controller();
    await client.authenticate();
    expect((await client.refresh()).nextAction).toBe("review-fees");
    await client.reviewFees();
    expect((await client.endMembership()).nextAction).toBe("revoke-authority");
    const revoke = await client.prepare("revoke-authority");
    const stop = await client.submit(revoke, f.submit("proxy"));
    expect(stop.membershipEnded).toBe(true);
    expect(stop.authorityRemoved).toBe(true);
    expect(stop.remainingPositions).toHaveLength(1);
    const conversion = await client.prepare("convert-alpha", {
      positions: [{ hotkey: f.hotkey, netuid: 1, amountRao: "1000000000" }],
      slippageBps: 160,
      allowPartial: false,
    });
    expect(conversion.conversion?.executable[0].minimumPriceRao).toBe(
      "984000000",
    );
    const done = await client.submit(conversion, f.submit("stake"));
    expect(done.nextAction).toBe("done");
    expect(done.pending).toBeNull();
    expect(f.signRaw).toHaveBeenCalledTimes(3); // Message signatures only; chain submitter is synthetic.
  });
  it("requires explicit fee review/payment then records only the canonical exact payment receipt", async () => {
    const f = await fixture(true),
      client = f.controller();
    await client.authenticate();
    await client.reviewFees();
    await expect(client.endMembership()).rejects.toThrow("fees first");
    const payment = await client.prepare("pay-exit-fees");
    expect(payment.fees?.totalAmountRao).toBe("1000");
    const paid = await client.submit(payment, f.submit("fee"));
    expect(paid.nextAction).toBe("end-membership");
    expect(paid.pending).toBeNull();
    expect((await client.endMembership()).membershipEnded).toBe(true);
  });
  it("continues two-signer authority removal and protected conversion across reload, without confusing approval with execution", async () => {
    const f = await fixture(false, true),
      first = f.controller();
    await first.authenticate();
    await first.reviewFees();
    await first.endMembership();
    const review = await first.prepare("revoke-authority");
    expect(review.multisig?.action).toBe("approve");
    const approved = await first.submit(review, f.submit("proxy"));
    expect(approved.nextAction).toBe("await-signers");
    expect(approved.authorityRemoved).toBe(false);
    expect(approved.pending?.details?.multisig?.approvals).toHaveLength(1);
    await expect(first.prepareContinuation()).rejects.toThrow(
      "already approved",
    );
    f.connectSecondSigner();
    const second = f.controller();
    await second.authenticate();
    const execution = await second.prepareContinuation();
    expect(execution.multisig?.action).toBe("execute");
    const revoked = await second.submit(execution, f.submit("proxy"));
    expect(revoked.authorityRemoved).toBe(true);
    expect(revoked.remainingPositions).toHaveLength(1);
    expect(revoked.pending).toBeNull();
    await second.reviewFees();
    const sell = await second.prepare("convert-alpha", {
      positions: [{ hotkey: f.hotkey, netuid: 1, amountRao: "1000000000" }],
      slippageBps: 160,
      allowPartial: false,
    });
    const saleApproved = await second.submit(sell, f.submit("stake"));
    expect(saleApproved.remainingPositions).toHaveLength(1);
    expect(saleApproved.nextAction).toBe("await-signers");
    f.connectFirstSigner();
    const final = f.controller();
    await final.authenticate();
    await final.reviewFees();
    const fixed = await final.prepareContinuation();
    expect(fixed.conversion?.protection).toBe("fixed-minimum");
    expect(fixed.conversion?.executable[0].minimumPriceRao).toBe("984000000");
    expect((await final.submit(fixed, f.submit("stake"))).nextAction).toBe(
      "done",
    );
  });
  it("executes a two-signer fee bundle only after threshold, with the original recipients/amounts and backend settlement proof", async () => {
    const f = await fixture(true, true),
      first = f.controller();
    await first.authenticate();
    await first.reviewFees();
    const fee = await first.prepare("pay-exit-fees");
    expect(fee.fees?.totalAmountRao).toBe("1000");
    expect(() => {
      fee.fees!.transfers[0].amountRao = "9999";
    }).toThrow();
    expect((await first.submit(fee, f.submit("fee"))).nextAction).toBe(
      "await-signers",
    );
    f.connectSecondSigner();
    const second = f.controller();
    await second.authenticate();
    const execute = await second.prepareContinuation();
    expect(execute.fees?.totalAmountRao).toBe("1000");
    const paid = await second.submit(execute, f.submit("fee"));
    expect(paid.pending).toBeNull();
    expect(paid.nextAction).toBe("end-membership");
  });
  it("cancels an expired multisig fee proposal without paying it, using only the original depositor", async () => {
    const f = await fixture(true, true),
      first = f.controller();
    await first.authenticate();
    await first.reviewFees();
    await first.submit(await first.prepare("pay-exit-fees"), f.submit("fee"));
    f.setTime(1700000900001);
    f.connectSecondSigner();
    const second = f.controller();
    await second.authenticate();
    await expect(second.prepareContinuation()).rejects.toThrow("expired");
    await expect(second.prepareCancellation()).rejects.toThrow("depositor");
    f.connectFirstSigner();
    const owner = f.controller();
    await owner.authenticate();
    const cancel = await owner.prepareCancellation();
    expect(cancel.multisig?.action).toBe("cancel");
    const stopped = await owner.submit(cancel, f.submit("fee"));
    expect(stopped.pending).toBeNull();
    expect(stopped.membershipEnded).toBe(false);
    expect(stopped.authorityRemoved).toBe(false);
    expect(stopped.remainingPositions).toHaveLength(1);
  });
  it("reconciles a lost approval receipt without replay and blocks shared-proxy revocation", async () => {
    const f = await fixture(false, true),
      client = f.controller();
    await client.authenticate();
    await client.reviewFees();
    await client.endMembership();
    const review = await client.prepare("revoke-authority"),
      actual = f.submit("proxy");
    let receipt: any;
    await expect(
      client.submit(review, async (...args) => {
        receipt = await actual(...args);
        throw new Error("Response lost after inclusion");
      }),
    ).rejects.toThrow("Response lost");
    expect((await client.refresh()).nextAction).toBe("reconcile-transaction");
    expect((await client.reconcile(receipt)).nextAction).toBe("await-signers");
    expect(actual).toHaveBeenCalledTimes(1);
    f.setDependencies([{ strategyId: id(88) }]);
    f.connectSecondSigner();
    const second = f.controller();
    await second.authenticate();
    await expect(second.prepareContinuation()).rejects.toThrow(
      "another membership",
    );
  });
  it.each(["execution", "cancellation"] as const)(
    "observes external %s only for an exact previously verified proposal",
    async (kind) => {
      const f = await fixture(false, true),
        first = f.controller();
      await first.authenticate();
      await first.reviewFees();
      await first.endMembership();
      const approved = await first.submit(
        await first.prepare("revoke-authority"),
        f.submit("proxy"),
      );
      const saved = JSON.stringify(approved.pending),
        key = `trustedstake:sdk:exit:v1:pending:${f.wallet.genesisHash}:${f.wallet.managedWalletAddress}`;
      if (kind === "execution") f.connectSecondSigner();
      const actor = f.controller();
      await actor.authenticate();
      const review =
        kind === "execution"
          ? await actor.prepareContinuation()
          : await actor.prepareCancellation();
      const actual = f.submit("proxy");
      let receipt: any;
      await actor.submit(review, async (...args) => {
        receipt = await actual(...args);
        return receipt;
      });
      // Another browser has its own saved operation, with no hash for the other signer's action.
      f.storage.setItem(key, saved);
      const observer = f.controller();
      await observer.authenticate();
      const result = await observer.reconcile(receipt);
      expect(result.pending).toBeNull();
      expect(result.authorityRemoved).toBe(kind === "execution");
      expect(actual).toHaveBeenCalledTimes(1);
      f.storage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(saved), state: "needs-review" }),
      );
      expect((await observer.reconcile(receipt)).pending).not.toBeNull();
    },
  );
  it.each(["approval", "cancellation"] as const)(
    "rejects a substituted outer multisig %s call before wallet submission",
    async (kind) => {
      const f = await fixture(false, true),
        client = f.controller();
      await client.authenticate();
      await client.reviewFees();
      await client.endMembership();
      if (kind === "cancellation")
        await client.submit(
          await client.prepare("revoke-authority"),
          f.submit("proxy"),
        );
      const review =
        kind === "approval"
          ? await client.prepare("revoke-authority")
          : await client.prepareCancellation();
      await expect(
        client.submit(review, async (tx: any, check) => {
          tx.method.toHex = () => "0xdeadbeef";
          await check();
          throw new Error("Should not reach signing");
        }),
      ).rejects.toThrow("changed");
      expect((await client.refresh()).authorityRemoved).toBe(false);
    },
  );
  it("holds a lost second-signer execution response and reports partial conversion residuals after canonical reconciliation", async () => {
    const f = await fixture(false, true),
      first = f.controller();
    await first.authenticate();
    await first.reviewFees();
    await first.endMembership();
    await first.submit(
      await first.prepare("revoke-authority"),
      f.submit("proxy"),
    );
    f.connectSecondSigner();
    const second = f.controller();
    await second.authenticate();
    let receipt: any;
    const actual = f.submit("proxy");
    await expect(
      second.submit(await second.prepareContinuation(), async (...args) => {
        receipt = await actual(...args);
        throw Error("Lost final execution response");
      }),
    ).rejects.toThrow("Lost final");
    expect((await second.refresh()).nextAction).toBe("reconcile-transaction");
    expect((await second.refresh()).authorityRemoved).toBe(true);
    expect((await second.reconcile(receipt)).pending).toBeNull();
    await second.reviewFees();
    await second.submit(
      await second.prepare("convert-alpha", {
        positions: [{ hotkey: f.hotkey, netuid: 1, amountRao: "1000000000" }],
        slippageBps: 160,
        allowPartial: true,
      }),
      f.submit("stake"),
    );
    f.connectFirstSigner();
    const final = f.controller();
    await final.authenticate();
    await final.reviewFees();
    const execute = f.submit("stake");
    const partial = await final.submit(
      await final.prepareContinuation(),
      async (...args) => {
        const r = await execute(...args);
        f.setStake("100");
        return r;
      },
    );
    expect(partial.pending).toBeNull();
    expect(partial.remainingPositions[0].amountRao).toBe("100");
    expect(partial.nextAction).toBe("choose-conversion");
  });
  it("does not let an invalid message signature strand membership cessation", async () => {
    const f = await fixture(),
      client = f.controller();
    await client.authenticate();
    await client.reviewFees();
    f.signRaw.mockResolvedValueOnce({ signature: "invalid" });
    await expect(client.endMembership()).rejects.toThrow(
      "Invalid wallet signature",
    );
    expect((await client.refresh()).pending).toBeNull();
  });
  it("rechecks transaction bytes after the controller's final context refresh", async () => {
    const f = await fixture(false, true),
      client = f.controller();
    await client.authenticate();
    await client.reviewFees();
    await client.endMembership();
    const review = await client.prepare("revoke-authority");
    const read = f.chain.read.bind(f.chain);
    let calls = 0;
    await expect(
      client.submit(review, async (tx: any, check) => {
        f.chain.read = async (...args) => {
          const state = await read(...args);
          if (++calls === 3) tx.method.toHex = () => "0xdeadbeef";
          return state;
        };
        await check();
        throw Error("Should never reach signing");
      }),
    ).rejects.toThrow("changed");
    expect((await client.refresh()).authorityRemoved).toBe(false);
  });
  it("reports verified partial conversion and manual completion without repeating a financial action", async () => {
    const f = await fixture(),
      client = f.controller();
    await client.authenticate();
    await client.reviewFees();
    await client.endMembership();
    await client.submit(
      await client.prepare("revoke-authority"),
      f.submit("proxy"),
    );
    const review = await client.prepare("convert-alpha", {
        positions: [{ hotkey: f.hotkey, netuid: 1, amountRao: "1000000000" }],
        slippageBps: 160,
        allowPartial: true,
      }),
      actual = f.submit("stake");
    const partial = await client.submit(review, async (...args) => {
      const receipt = await actual(...args);
      f.setStake("100");
      return receipt;
    });
    expect(partial.remainingPositions[0].amountRao).toBe("100");
    expect(partial.nextAction).toBe("choose-conversion");
    expect(partial.pending).toBeNull();
    f.setStake("0");
    expect((await client.refresh()).nextAction).toBe("done");
    expect(actual).toHaveBeenCalledTimes(1);
  });
  it("preserves interrupted/unknown financial work across reload and manual completion", async () => {
    const f = await fixture(),
      client = f.controller();
    await client.authenticate();
    await client.reviewFees();
    await client.endMembership();
    const review = await client.prepare("revoke-authority");
    await expect(
      client.submit(review, async (_tx, check, onSigned) => {
        await check();
        onSigned(hash("c"));
        throw new Error("Response lost");
      }),
    ).rejects.toThrow("Response lost");
    f.setProxy(false);
    const reloaded = f.controller(),
      snapshot = await reloaded.refresh();
    expect(snapshot.authorityRemoved).toBe(true);
    expect(snapshot.nextAction).toBe("reconcile-transaction");
    expect(snapshot.pending?.transactionHash).toBe(hash("c"));
    await expect(
      reloaded.prepare("convert-alpha", {
        positions: [{ hotkey: f.hotkey, netuid: 1, amountRao: "1000000000" }],
        slippageBps: 160,
        allowPartial: false,
      }),
    ).rejects.toThrow("earlier transaction");
  });
  it("routes reloaded or expired fee evidence through fee review before conversion", async () => {
    const f = await fixture(),
      client = f.controller();
    await client.authenticate();
    await client.reviewFees();
    await client.endMembership();
    await client.submit(
      await client.prepare("revoke-authority"),
      f.submit("proxy"),
    );
    expect((await f.controller().refresh()).nextAction).toBe("review-fees");
    f.setTime(1700000060001);
    expect((await client.refresh()).nextAction).toBe("review-fees");
  });
  it("reconciles lost membership responses or retries the same generation without replaying a chain action", async () => {
    const f = await fixture(),
      client = f.controller();
    await client.authenticate();
    await client.reviewFees();
    f.failStop("before");
    await expect(client.endMembership()).rejects.toThrow();
    expect((await client.refresh()).nextAction).toBe("end-membership");
    f.setTime(1700000060001);
    await client.reviewFees();
    expect((await client.endMembership()).membershipEnded).toBe(true);
    const g = await fixture(),
      other = g.controller();
    await other.authenticate();
    await other.reviewFees();
    g.failStop("after");
    await expect(other.endMembership()).rejects.toThrow();
    const reconciled = await g.controller().refresh();
    expect(reconciled.membershipEnded).toBe(true);
    expect(reconciled.pending).toBeNull();
  });
  it("recovers a proven message-signing rejection without clearing unknown financial submissions", async () => {
    const f = await fixture(),
      client = f.controller();
    await client.authenticate();
    await client.reviewFees();
    f.signRaw.mockRejectedValueOnce(new Error("Wallet rejected message"));
    await expect(client.endMembership()).rejects.toThrow(
      "Wallet rejected message",
    );
    expect((await client.refresh()).pending).toBeNull();
    await client.endMembership();
    const review = await client.prepare("revoke-authority");
    // The SDK submitter proves send was never called for an unsupported unsigned object.
    await expect(
      client.submit(
        review,
        createExitWalletSubmitter(f.wallet.signerAddress, {} as any, () => {}),
      ),
    ).rejects.toThrow("supported unsigned transaction");
    expect((await client.refresh()).pending).toBeNull();
  });
  it("rejects repeated clicks and account/runtime/expired review before financial handoff", async () => {
    const f = await fixture(),
      client = f.controller();
    await client.authenticate();
    await client.reviewFees();
    await client.endMembership();
    const review = await client.prepare("revoke-authority"),
      submit = f.submit("proxy");
    f.checkFlow.mockImplementation(() => {
      throw new Error("Account changed");
    });
    await expect(client.submit(review, submit)).rejects.toThrow(
      "Account changed",
    );
    expect(submit).not.toHaveBeenCalled();
    f.checkFlow.mockImplementation(() => {});
    await expect(client.submit(review, submit)).rejects.toThrow("already used");
  });
});
