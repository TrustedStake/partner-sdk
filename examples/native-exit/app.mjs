import {
  createNativeExitController,
  createWebLocksCoordinator,
} from "/dist/browser.js";
const multi = new URL(location.href).searchParams.get("multisig") === "1",
  key = `ts-exit-demo:${multi}`;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  hash = (n) => "0x" + n.repeat(64);
// Deliberately synthetic format-only identities; never use these with a chain adapter.
const member = "5" + "a".repeat(47),
  delegate = "5" + "b".repeat(47),
  signers = multi ? ["5" + "c".repeat(47), "5" + "d".repeat(47)] : [member];
let model = JSON.parse(localStorage.getItem(key) || "null") ?? {
  member: true,
  proxy: true,
  stake: "1000000000",
  head: 100,
  signer: 0,
  proposal: null,
  runtime: "482:1",
  receipts: {},
  unknown: false,
  fail: false,
  partial: false,
  dependencies: 0,
};
const save = () => localStorage.setItem(key, JSON.stringify(model));
const wallet = {
  managedWalletAddress: member,
  signerAddress: signers[model.signer],
  genesisHash: hash("1"),
  signer: {},
  assertCurrentFlow() {
    if (wallet.signerAddress !== signers[model.signer])
      throw Error("Signer changed; reload review.");
  },
};
const selection = {
  strategyId: id(1),
  strategyTable: "custom_strategies",
  proxy: delegate,
  expectedGeneration: id(2),
};
const scope = () => ({
  wallet: member,
  signer: wallet.signerAddress,
  genesisHash: wallet.genesisHash,
  strategyId: id(1),
  strategyTable: "custom_strategies",
  delegate,
  generation: id(2),
});
const emptyFees = () => ({
  required: false,
  bundleId: null,
  strategyId: id(1),
  memberSs58: member,
  network: null,
  transfers: [],
  totalAmountRao: "0",
  paymentReferenceHash: null,
  quoteExpiresAt: null,
  reviewItems: [],
});
const api = {
  sameWallet: (a, b) => a === b,
  authenticate: async () => {},
  context: async () => ({
    schemaVersion: 1,
    walletAddress: member,
    genesisHash: hash("1"),
    selection,
    membership: model.member ? "active" : "ended",
    canStopMembership: true,
    otherActiveMemberships: model.dependencies,
    otherProxyDependencies: Array.from({ length: model.dependencies }, () => ({
      strategyId: id(9),
    })),
    allocation: { state: "quiescent", unresolvedChainEffects: false, jobs: [] },
    checkedAt: new Date().toISOString(),
  }),
  checkout: async () => emptyFees(),
  stop: async () => {
    model.member = false;
    save();
  },
  recordFeePayment: async () => {
    throw Error("No simulated fees are configured.");
  },
};
const positions = () =>
  model.stake === "0"
    ? []
    : [{ hotkey: delegate, netuid: 1, amountRao: model.stake, lockedRao: "0" }];
const read = async () => ({
  runtime: model.runtime,
  blockHash: hash("1"),
  blockNumber: model.head,
  checkedAt: Date.now(),
  proxyPresent: model.proxy,
  positions: positions(),
});
const prepare = async (intent, check) => {
  const runtime = model.runtime,
    callHash = hash(intent === "revoke-authority" ? "2" : "3");
  return {
    transaction: { intent, callHash },
    callHash,
    callDataHex: "0x1234",
    assertCurrent: async () => {
      await check();
      if (model.runtime !== runtime)
        throw Error("Runtime changed; review again.");
    },
  };
};
const chain = {
  read,
  prepareFeePayment: async () => {
    throw Error("Not configured");
  },
  prepareRevocation: (s, check) => prepare("revoke-authority", check),
  prepareConversion: async (s, selected, bps, partial, check) => {
    if (!Number.isInteger(bps) || bps < 0 || bps > 5000)
      throw Error("Choose a valid slippage limit.");
    const p = await prepare("convert-alpha", check);
    model.partial = partial;
    const quote = {
      selected,
      executable: selected.map((x) => ({
        ...x,
        minimumPriceRao: String(
          (1000000000n * (10000n - BigInt(bps))) / 10000n,
        ),
        estimatedTaoRao: "990000000",
      })),
      skipped: [],
      slippageBps: bps,
      protection: "relative-price",
      allowPartial: partial,
      expiresAt: Date.now() + 60000,
    };
    model.conversionQuote = quote;
    save();
    return { ...p, quote };
  },
  prepareFrozenConversion: async (s, hex, check) => ({
    ...(await prepare("convert-alpha", check)),
    quote: {
      ...structuredClone(model.conversionQuote),
      slippageBps: null,
      protection: "fixed-minimum",
      expiresAt: Date.now() + 60000,
    },
  }),
  wrapMultisig: async (s, p, config, check, existing) => {
    check();
    if (existing?.approvals?.includes(wallet.signerAddress))
      throw Error("This signer has already approved.");
    const op = existing ?? {
      id: id(7),
      chainId: hash("1"),
      threshold: 2,
      signatories: signers,
      sortedSignatories: signers,
      multisigAddress: member,
      managedAccount: member,
      operationKind: "other",
      operationLabel: "Synthetic exit",
      callDataHex: p.callDataHex,
      callHashHex: p.callHash,
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runtime: { specVersion: 482, transactionVersion: 1 },
      approvals: [],
    };
    return {
      ...p,
      transaction: { ...p.transaction, multi: true, execute: !!existing },
      multisig: op,
      multisigExecution: !!existing,
    };
  },
  receipt: async (p, tx, block) => {
    const r = model.receipts[tx];
    if (!r || r.block !== block || r.approval) return { outcome: "unknown" };
    return {
      outcome: r.failed ? "failed" : "succeeded",
      operationId: p.operationId,
      scope: p.review.scope,
      callHash: p.callHash,
      transactionHash: tx,
      blockHash: block,
      blockNumber: r.height,
      extrinsicIndex: 0,
      innerDispatchVerified: true,
    };
  },
  verifyApproval: async (p, tx, block) => {
    const r = model.receipts[tx];
    if (!r?.approval || r.block !== block) return null;
    return {
      operationId: p.operationId,
      scope: p.review.scope,
      callHash: p.callHash,
      transactionHash: tx,
      blockHash: block,
      blockNumber: r.height,
      extrinsicIndex: 0,
      approvalVerified: true,
      operation: { ...p.details.multisig, ...model.proposal },
    };
  },
};
const controller = createNativeExitController({
  api,
  chain,
  wallet,
  selection,
  storage: localStorage,
  coordinator: createWebLocksCoordinator(navigator.locks, `demo:${multi}`),
  ...(multi ? { multisig: { signatories: signers, threshold: 2 } } : {}),
  now: Date.now,
  uuid: () => crypto.randomUUID(),
  sha256: async (s) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join(""),
});
let authenticated = false,
  review,
  snapshot;
const $ = (id) => document.getElementById(id);
async function render() {
  snapshot = await controller.refresh();
  $("membership").textContent = snapshot.membershipEnded ? "Ended" : "Active";
  $("authority").textContent = snapshot.authorityRemoved
    ? "Removed"
    : "Present";
  $("holdings").textContent =
    snapshot.remainingPositions
      .map((x) => `${x.amountRao} alpha units on SN${x.netuid}`)
      .join(", ") || "None";
  $("progress").textContent =
    snapshot.pending?.state === "awaiting-signers"
      ? `${snapshot.pending.details.multisig.approvals.length} of 2 signers approved. No execution yet.`
      : snapshot.nextAction === "done"
        ? "Selected exit stages are verified in this simulation. No external transfer."
        : `Next: ${snapshot.nextAction.replaceAll("-", " ")}`;
  $("next").textContent = !authenticated
    ? "Authorize simulated review"
    : review
      ? `Simulate wallet ${review.multisig?.action || "confirmation"}`
      : {
          "review-fees": "Review fees",
          "end-membership": "End membership",
          "revoke-authority": "Review authority removal",
          "choose-conversion": "Review conversion",
          "await-signers": "Review pending proposal",
          "reconcile-transaction": "Read transaction status",
          done: "Refresh holdings",
        }[snapshot.nextAction] || "Refresh status";
  $("conversion").hidden =
    !!review || snapshot.nextAction !== "choose-conversion";
  $("switch").hidden = snapshot.nextAction !== "await-signers";
  $("review").textContent = review
    ? review.conversion
      ? `Convert selected alpha into TAO in this wallet. ${review.conversion.protection}; partial fills ${review.conversion.allowPartial ? "allowed" : "disabled"}. No external transfer. Enforced minima: ${review.conversion.executable.map((p) => `SN${p.netuid}: ${p.minimumPriceRao} rao`).join(", ")}. Excluded: ${review.conversion.skipped.map((p) => `SN${p.netuid} (${p.reason})`).join(", ") || "none"}.`
      : `${review.intent.replaceAll("-", " ")}. ${review.multisig ? review.multisig.action + " with signer " + (model.signer + 1) : "Confirm only this action"}.`
    : "";
  $("technical").textContent = JSON.stringify(
    {
      nextAction: snapshot.nextAction,
      review,
      pending: snapshot.pending?.state,
    },
    null,
    2,
  );
  window.demo.snapshot = snapshot;
}
const submit = async (tx, check, onSigned) => {
  await check();
  model.head++;
  const transactionHash = "0x" + model.head.toString(16).padStart(64, "0"),
    blockHash = "0x" + (model.head + 10000).toString(16).padStart(64, "0");
  onSigned(transactionHash);
  const approval = tx.multi && !tx.execute;
  model.receipts[transactionHash] = {
    block: blockHash,
    height: model.head,
    approval,
    failed: model.fail,
  };
  if (approval)
    model.proposal = {
      timepoint: { height: model.head, index: 0 },
      approvals: [wallet.signerAddress],
      depositor: wallet.signerAddress,
    };
  else if (!model.fail) {
    if (tx.intent === "revoke-authority") model.proxy = false;
    else model.stake = model.partial ? "100" : "0";
    model.proposal = null;
  }
  save();
  if (model.unknown)
    throw Error("Response lost. Recorded hash retained; no replay.");
  return { transactionHash, blockHash };
};
$("next").onclick = async () => {
  if ($("next").disabled) return;
  $("next").disabled = true;
  $("error").textContent = "";
  try {
    if (!authenticated) {
      await controller.authenticate();
      authenticated = true;
    } else if (review) {
      const current = review;
      review = undefined;
      await controller.submit(current, submit);
    } else if (snapshot.nextAction === "review-fees")
      await controller.reviewFees();
    else if (snapshot.nextAction === "end-membership")
      await controller.endMembership();
    else if (snapshot.nextAction === "revoke-authority")
      review = await controller.prepare("revoke-authority");
    else if (snapshot.nextAction === "choose-conversion")
      review = await controller.prepare("convert-alpha", {
        positions: positions(),
        slippageBps: Number($("slippage").value),
        allowPartial: $("partial").checked,
      });
    else if (snapshot.nextAction === "await-signers") {
      if (snapshot.pending.review.intent !== "pay-exit-fees")
        await controller.reviewFees();
      review = await controller.prepareContinuation();
    } else if (snapshot.nextAction === "reconcile-transaction") {
      const tx = snapshot.pending?.transactionHash,
        receipt = model.receipts[tx];
      if (receipt)
        await controller.reconcile({
          transactionHash: tx,
          blockHash: receipt.block,
        });
      else
        throw Error(
          "No exact inclusion receipt available. Keep the operation held.",
        );
    }
    await render();
  } catch (e) {
    $("error").textContent = e.message;
    await render();
  } finally {
    $("next").disabled = false;
  }
};
$("switch").onclick = () => {
  model.signer = 1 - model.signer;
  save();
  location.reload();
};
window.demo = {
  snapshot: null,
  refresh: render,
  model,
  inject(value) {
    Object.assign(model, value);
    save();
  },
  reset() {
    localStorage.clear();
    location.reload();
  },
};
await render();
