import type {
  ExitPosition,
  ExitChainState,
  ExitConversionSelection,
  ExitConversionQuote,
} from "../exit-types.ts";
export type {
  ExitPosition,
  ExitChainState,
  ExitConversionSelection,
  ExitConversionQuote,
} from "../exit-types.ts";
import {
  wrapMultisigExit,
  verifyExitApproval,
  prepareExitCancellation,
} from "./exit-multisig.ts";
import { hydrateCallFromHex } from "./multisig.ts";
import { parseExitCheckout, type ExitCheckout } from "../exit-api.ts";
import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { EventRecord } from "@polkadot/types/interfaces";
import {
  blake2AsHex,
  decodeAddress,
  encodeAddress,
} from "@polkadot/util-crypto";
import type { CanonicalExitReceipt, ExitScope, ExitPending } from "../exit.ts";
import type { PendingMultisigOp } from "./types.ts";
import {
  verifyMultisigReceipt,
  runtimeIdentity,
  sameTimepoint,
} from "./multisig-recovery.ts";
import { decodeBatchEvents } from "./receipt-events.ts";
import { HASH } from "../contracts.ts";

const address = (input: string) => encodeAddress(decodeAddress(input), 42);
const amount = (value: unknown): bigint => {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error("Invalid chain amount.");
  const n = BigInt(text);
  if (n > (1n << 64n) - 1n) throw new Error("Invalid chain amount.");
  return n;
};
const runtime = (api: ApiPromise) => JSON.stringify(runtimeIdentity(api));
export interface PreparedNativeExit {
  transaction: SubmittableExtrinsic<"promise">;
  callHash: string;
  callDataHex: string;
  /** Must also be called by the host's guarded wallet submitter immediately before signing. */
  assertCurrent(): Promise<void>;
}
/** Generic public chain mechanics only. No strategy allocation/trading engine or automatic submission. */
export function createPolkadotNativeExitAdapter(
  api: ApiPromise,
  now: () => number = Date.now,
) {
  async function read(inputScope: ExitScope): Promise<ExitChainState> {
    const scope = structuredClone(inputScope),
      beforeRuntime = runtime(api);
    if (api.genesisHash.toHex() !== scope.genesisHash)
      throw new Error("Exit network changed.");
    const head = await api.rpc.chain.getFinalizedHead(),
      header = await api.rpc.chain.getHeader(head);
    const finalizedRuntime = await api.rpc.state.getRuntimeVersion(head);
    if (
      JSON.stringify({
        specVersion: finalizedRuntime.specVersion.toNumber(),
        transactionVersion: finalizedRuntime.transactionVersion.toNumber(),
      }) !== beforeRuntime
    )
      throw new Error("Finalized exit runtime is not current. Refresh.");
    const at = await api.at(head),
      rows = (
        await at.call.stakeInfoRuntimeApi.getStakeInfoForColdkey(scope.wallet)
      ).toJSON();
    if (!Array.isArray(rows) || rows.length > 10000)
      throw new Error("Unable to verify exit holdings.");
    const seen = new Set<string>();
    const positions = rows.map((raw: unknown) => {
      if (!raw || typeof raw !== "object")
        throw new Error("Invalid exit position.");
      const row = raw as Record<string, unknown>,
        hotkey = address(String(row.hotkey)),
        netuid = Number(amount(row.netuid));
      if (
        address(String(row.coldkey)) !== address(scope.wallet) ||
        netuid > 65535 ||
        seen.has(`${hotkey}:${netuid}`)
      )
        throw new Error("Invalid exit position.");
      seen.add(`${hotkey}:${netuid}`);
      const stake = amount(row.stake),
        locked = amount(row.locked);
      if (locked > stake) throw new Error("Invalid locked stake.");
      return {
        hotkey,
        netuid,
        amountRao: stake.toString(),
        lockedRao: locked.toString(),
      };
    });
    const proxies = (await at.query.proxy.proxies(scope.wallet)).toJSON();
    if (
      !Array.isArray(proxies) ||
      !Array.isArray(proxies[0]) ||
      proxies[0].length > 256
    )
      throw new Error("Unable to verify exit proxy.");
    let proxyPresent = false;
    for (const row of proxies[0]) {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        typeof row.delegate !== "string" ||
        typeof row.proxyType !== "string" ||
        !Number.isSafeInteger(row.delay)
      )
        throw new Error("Invalid exit proxy.");
      if (
        address(row.delegate) === address(scope.delegate) &&
        row.proxyType === "Staking" &&
        row.delay === 0
      )
        proxyPresent = true;
    }
    const blockNumber = Number(header.number.toString());
    if (
      !Number.isSafeInteger(blockNumber) ||
      blockNumber < 0 ||
      !HASH.test(head.toHex())
    )
      throw new Error("Invalid exit block.");
    if (
      api.genesisHash.toHex() !== scope.genesisHash ||
      runtime(api) !== beforeRuntime
    )
      throw new Error("Exit network or runtime changed.");
    return {
      runtime: beforeRuntime,
      blockHash: head.toHex(),
      blockNumber,
      checkedAt: now(),
      proxyPresent,
      positions,
    };
  }
  function prepared(
    scope: ExitScope,
    state: ExitChainState,
    tx: SubmittableExtrinsic<"promise">,
    check: () => Promise<void>,
    expiresAt: number,
  ): PreparedNativeExit {
    if (runtime(api) !== state.runtime)
      throw new Error("Exit runtime changed. Review again.");
    const callDataHex = tx.method.toHex(),
      callHash = blake2AsHex(callDataHex, 256);
    const assertCurrent = async () => {
      if (
        now() >= expiresAt ||
        api.genesisHash.toHex() !== scope.genesisHash ||
        runtime(api) !== state.runtime ||
        tx.method.toHex() !== callDataHex
      )
        throw new Error("Exit review changed or expired.");
      await check();
      if (
        now() >= expiresAt ||
        api.genesisHash.toHex() !== scope.genesisHash ||
        runtime(api) !== state.runtime ||
        tx.method.toHex() !== callDataHex ||
        blake2AsHex(tx.method.toHex(), 256) !== callHash
      )
        throw new Error("Exit review changed or expired.");
    };
    return { transaction: tx, callDataHex, callHash, assertCurrent };
  }
  async function prepareRevocation(
    inputScope: ExitScope,
    assertExitAuthority: () => Promise<void>,
  ): Promise<PreparedNativeExit> {
    const scope = structuredClone(inputScope);
    await assertExitAuthority();
    const state = await read(scope);
    if (!state.proxyPresent)
      throw new Error("Strategy authority is already absent.");
    const tx = api.tx.proxy.removeProxy(scope.delegate, "Staking", 0);
    return prepared(
      scope,
      state,
      tx,
      async () => {
        await assertExitAuthority();
        if (!(await read(scope)).proxyPresent)
          throw new Error("Strategy authority changed.");
      },
      now() + 60_000,
    );
  }
  async function prepareConversion(
    inputScope: ExitScope,
    selection: ExitConversionSelection[],
    slippageBps: number,
    allowPartial: boolean,
    assertExitAuthority: () => Promise<void>,
  ): Promise<PreparedNativeExit & { quote: ExitConversionQuote }> {
    const scope = structuredClone(inputScope),
      selected = structuredClone(selection);
    if (
      !Number.isSafeInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps >= 10000 ||
      typeof allowPartial !== "boolean" ||
      !Array.isArray(selected) ||
      !selected.length ||
      selected.length > 8
    )
      throw new Error(
        "Choose up to eight positions and explicit price/partial-fill protection.",
      );
    await assertExitAuthority();
    const state = await read(scope),
      at = await api.at(state.blockHash),
      seen = new Set<string>();
    const minimum = amount(at.consts.subtensorModule.initialMinStake);
    if (minimum <= 0n) throw new Error("Trading minimum is unavailable.");
    const calls: SubmittableExtrinsic<"promise">[] = [],
      executable: ExitConversionQuote["executable"] = [],
      skipped: ExitConversionQuote["skipped"] = [];
    for (const item of selected) {
      item.hotkey = address(item.hotkey);
      const key = `${item.hotkey}:${item.netuid}`,
        n = amount(item.amountRao);
      if (
        !Number.isSafeInteger(item.netuid) ||
        item.netuid < 0 ||
        item.netuid > 65535 ||
        seen.has(key) ||
        n <= 0n
      )
        throw new Error("Invalid selected exit position.");
      seen.add(key);
      const held = state.positions.find(
        (p) => p.hotkey === item.hotkey && p.netuid === item.netuid,
      );
      if (!held || n > amount(held.amountRao))
        throw new Error("Exit holdings changed.");
      const skip = (reason: ExitConversionQuote["skipped"][number]["reason"]) =>
        skipped.push({ hotkey: item.hotkey, netuid: item.netuid, reason });
      if (amount(held.lockedRao) > 0n) {
        skip("locked");
        continue;
      }
      if (item.netuid === 0) {
        if (n < minimum) {
          skip("below-minimum");
          continue;
        }
        calls.push(
          api.tx.subtensorModule.removeStake(item.hotkey, 0, n.toString()),
        );
        executable.push({
          ...item,
          minimumPriceRao: "1000000000",
          estimatedTaoRao: n.toString(),
        });
        continue;
      }
      const enabled = (
        await at.query.subtensorModule.subtokenEnabled(item.netuid)
      ).toJSON();
      if (typeof enabled !== "boolean")
        throw new Error("Trading status is unavailable.");
      if (!enabled) {
        skip("disabled");
        continue;
      }
      const price = amount(
        await at.call.swapRuntimeApi.currentAlphaPrice(item.netuid),
      );
      const q = (
        await at.call.swapRuntimeApi.simSwapAlphaForTao(
          item.netuid,
          n.toString(),
        )
      ).toJSON();
      if (!q || typeof q !== "object" || Array.isArray(q))
        throw new Error("Exit quote is unavailable.");
      const quote = q as Record<string, unknown>,
        alphaFee = amount(quote.alphaFee),
        taoFee = amount(quote.taoFee),
        output = amount(quote.taoAmount);
      const limit = (price * (10000n - BigInt(slippageBps))) / 10000n;
      if (limit <= 0n)
        throw new Error("A nonzero protected price limit is required.");
      const conservative = ((n - alphaFee) * limit) / 1000000000n - taoFee;
      if (alphaFee >= n || conservative < minimum) {
        skip("below-minimum");
        continue;
      }
      if (output < conservative && !allowPartial) {
        skip("price-protection");
        continue;
      }
      if (typeof api.tx.subtensorModule.removeStakeLimit !== "function")
        throw new Error(
          "Protected exit calls are unavailable on this runtime.",
        );
      calls.push(
        api.tx.subtensorModule.removeStakeLimit(
          item.hotkey,
          item.netuid,
          n.toString(),
          limit.toString(),
          allowPartial,
        ),
      );
      executable.push({
        ...item,
        minimumPriceRao: limit.toString(),
        estimatedTaoRao: output.toString(),
      });
    }
    if (!calls.length)
      throw new Error(
        "No selected holdings can be converted within these limits.",
      );
    const quote: ExitConversionQuote = {
      selected: structuredClone(selected),
      executable: structuredClone(executable),
      skipped: structuredClone(skipped),
      slippageBps,
      protection: "relative-price",
      allowPartial,
      expiresAt: now() + 60_000,
    };
    for (const list of [quote.selected, quote.executable, quote.skipped]) {
      for (const row of list) Object.freeze(row);
      Object.freeze(list);
    }
    Object.freeze(quote);
    const result = prepared(
      scope,
      state,
      api.tx.utility.batchAll(calls),
      async () => {
        await assertExitAuthority();
        const fresh = await read(scope);
        for (const item of executable) {
          const prior = state.positions.find(
              (p) => p.hotkey === item.hotkey && p.netuid === item.netuid,
            ),
            current = fresh.positions.find(
              (p) => p.hotkey === item.hotkey && p.netuid === item.netuid,
            );
          if (
            !current ||
            current.amountRao !== prior?.amountRao ||
            current.lockedRao !== prior.lockedRao
          )
            throw new Error("Exit holdings changed. Review again.");
        }
      },
      quote.expiresAt,
    );
    return { ...result, quote };
  }
  async function prepareFrozenConversion(
    inputScope: ExitScope,
    callDataHex: string,
    assertExitAuthority: () => Promise<void>,
  ): Promise<PreparedNativeExit & { quote: ExitConversionQuote }> {
    const scope = structuredClone(inputScope);
    await assertExitAuthority();
    const state = await read(scope),
      at = await api.at(state.blockHash),
      tx = hydrateCallFromHex(api, callDataHex);
    if (
      String(tx.method.section) !== "utility" ||
      String(tx.method.method) !== "batchAll"
    )
      throw new Error(
        "Only an existing protected conversion batch can be reviewed.",
      );
    type Call = { section: unknown; method: unknown; args: ArrayLike<unknown> };
    const raw = Array.from(tx.method.args[0] as unknown as ArrayLike<Call>);
    if (!raw.length || raw.length > 8)
      throw new Error("Invalid existing conversion batch.");
    const executable: ExitConversionQuote["executable"] = [],
      selected: ExitConversionSelection[] = [],
      seen = new Set<string>();
    let partial: boolean | undefined;
    const minimum = amount(at.consts.subtensorModule.initialMinStake);
    if (minimum <= 0n) throw new Error("Trading minimum is unavailable.");
    for (const call of raw) {
      if (
        String(call.section) !== "subtensorModule" ||
        !["removeStake", "removeStakeLimit"].includes(String(call.method))
      )
        throw new Error("Unsupported existing conversion call.");
      const args = Array.from(call.args),
        hotkey = address(String(args[0])),
        netuid = Number(amount(args[1])),
        n = amount(args[2]),
        key = `${hotkey}:${netuid}`;
      if (netuid > 65535 || n <= 0n || seen.has(key))
        throw new Error("Invalid existing conversion position.");
      seen.add(key);
      const held = state.positions.find(
        (p) => p.hotkey === hotkey && p.netuid === netuid,
      );
      if (!held || amount(held.amountRao) < n || amount(held.lockedRao) > 0n)
        throw new Error("Existing conversion holdings changed.");
      if (String(call.method) === "removeStake") {
        if (netuid !== 0 || args.length !== 3 || n < minimum)
          throw new Error("Unbounded alpha conversion is unavailable.");
        selected.push({ hotkey, netuid, amountRao: n.toString() });
        executable.push({
          hotkey,
          netuid,
          amountRao: n.toString(),
          minimumPriceRao: "1000000000",
          estimatedTaoRao: n.toString(),
        });
        continue;
      }
      if (netuid === 0 || args.length !== 5)
        throw new Error("Invalid protected conversion call.");
      const limit = amount(args[3]),
        allowed = (args[4] as { toJSON?(): unknown })?.toJSON?.() ?? args[4];
      if (
        limit <= 0n ||
        typeof allowed !== "boolean" ||
        (partial !== undefined && partial !== allowed)
      )
        throw new Error("Existing conversion protection is unavailable.");
      partial = allowed;
      const enabled = (
        await at.query.subtensorModule.subtokenEnabled(netuid)
      ).toJSON();
      if (enabled !== true)
        throw new Error("Existing conversion trading is unavailable.");
      const rawQuote = (
        await at.call.swapRuntimeApi.simSwapAlphaForTao(netuid, n.toString())
      ).toJSON();
      if (!rawQuote || typeof rawQuote !== "object" || Array.isArray(rawQuote))
        throw new Error("Existing conversion quote is unavailable.");
      const q = rawQuote as Record<string, unknown>,
        fee = amount(q.alphaFee),
        taoFee = amount(q.taoFee),
        output = amount(q.taoAmount),
        conservative = ((n - fee) * limit) / 1000000000n - taoFee;
      if (
        fee >= n ||
        conservative < minimum ||
        (!allowed && output < conservative)
      )
        throw new Error(
          "Existing conversion cannot execute within its unchanged minimum prices.",
        );
      selected.push({ hotkey, netuid, amountRao: n.toString() });
      executable.push({
        hotkey,
        netuid,
        amountRao: n.toString(),
        minimumPriceRao: limit.toString(),
        estimatedTaoRao: output.toString(),
      });
    }
    const quote: ExitConversionQuote = {
      selected: structuredClone(selected),
      executable: structuredClone(executable),
      skipped: [],
      slippageBps: null,
      protection: "fixed-minimum",
      allowPartial: partial ?? false,
      expiresAt: now() + 60000,
    };
    for (const list of [quote.selected, quote.executable, quote.skipped]) {
      for (const row of list) Object.freeze(row);
      Object.freeze(list);
    }
    Object.freeze(quote);
    const result = prepared(
      scope,
      state,
      tx,
      async () => {
        await assertExitAuthority();
        const fresh = await read(scope);
        for (const p of selected) {
          const old = state.positions.find(
              (r) => r.hotkey === p.hotkey && r.netuid === p.netuid,
            ),
            current = fresh.positions.find(
              (r) => r.hotkey === p.hotkey && r.netuid === p.netuid,
            );
          if (
            !current ||
            current.amountRao !== old?.amountRao ||
            current.lockedRao !== old.lockedRao
          )
            throw new Error("Existing conversion holdings changed.");
        }
      },
      quote.expiresAt,
    );
    return { ...result, quote };
  }
  async function prepareFeePayment(
    inputScope: ExitScope,
    input: ExitCheckout,
    assertExitAuthority: () => Promise<void>,
  ): Promise<PreparedNativeExit> {
    const scope = structuredClone(inputScope),
      quote = parseExitCheckout(
        input,
        scope,
        (a, b) => address(a) === address(b),
        now(),
      );
    if (!quote.required || quote.reviewItems.length)
      throw new Error("Exit fee payment is absent or needs operator review.");
    await assertExitAuthority();
    const state = await read(scope);
    const calls = quote.transfers.map((t) =>
      api.tx.balances.transferKeepAlive(t.ss58, t.amountRao),
    );
    calls.push(api.tx.system.remarkWithEvent(quote.paymentReferenceHash!));
    return prepared(
      scope,
      state,
      api.tx.utility.batchAll(calls),
      assertExitAuthority,
      Date.parse(quote.quoteExpiresAt!),
    );
  }
  async function receipt(
    pending: ExitPending,
    transactionHash: string,
    blockHash: string,
    multisig?: PendingMultisigOp,
  ): Promise<CanonicalExitReceipt> {
    const { scope } = pending.review,
      { operationId, callHash } = pending;
    const observed =
      !pending.transactionHash &&
      pending.state === "awaiting-signers" &&
      !!pending.details?.multisig?.timepoint &&
      !!multisig &&
      sameTimepoint(pending.details.multisig.timepoint, multisig.timepoint);
    if (
      (!pending.transactionHash ||
        pending.transactionHash !== transactionHash) &&
      !observed
    )
      return { outcome: "unknown" };
    if (
      api.genesisHash.toHex() !== scope.genesisHash ||
      ![callHash, transactionHash, blockHash].every((h) => HASH.test(h))
    )
      throw new Error("Invalid exit receipt scope.");
    const tip = await api.rpc.chain.getFinalizedHead(),
      [head, header] = await Promise.all([
        api.rpc.chain.getHeader(tip),
        api.rpc.chain.getHeader(blockHash),
      ]);
    if (
      header.number.toBigInt() > head.number.toBigInt() ||
      header.number.toBigInt() <= BigInt(pending.review.blockNumber) ||
      (await api.rpc.chain.getBlockHash(header.number.toString())).toHex() !==
        blockHash
    )
      return { outcome: "unknown" };
    const block = await api.rpc.chain.getBlock(blockHash),
      index = block.block.extrinsics.findIndex(
        (tx) => tx.hash.toHex() === transactionHash,
      );
    if (index < 0) return { outcome: "unknown" };
    let outcome: "succeeded" | "failed" | "cancelled";
    if (multisig) {
      if (
        address(multisig.managedAccount) !== address(scope.wallet) ||
        address(multisig.multisigAddress) !== address(scope.wallet) ||
        multisig.chainId !== scope.genesisHash ||
        multisig.callHashHex !== callHash ||
        blake2AsHex(multisig.callDataHex, 256) !== callHash ||
        (!!pending.details?.multisig?.timepoint &&
          !sameTimepoint(
            multisig.timepoint,
            pending.details.multisig.timepoint,
          )) ||
        multisig.extrinsicHash !== transactionHash ||
        multisig.blockHash !== blockHash
      )
        throw new Error("Multisig exit receipt does not match.");
      const result = await verifyMultisigReceipt(api, multisig);
      if (
        result !== "executed" &&
        result !== "failed" &&
        result !== "cancelled"
      )
        return { outcome: "unknown" };
      outcome =
        result === "executed"
          ? "succeeded"
          : result === "cancelled"
            ? "cancelled"
            : "failed";
    } else {
      const tx = block.block.extrinsics[index];
      if (
        !tx.isSigned ||
        address(tx.signer.toString()) !== address(scope.wallet) ||
        address(scope.signer) !== address(scope.wallet) ||
        blake2AsHex(tx.method.toHex(), 256) !== callHash
      )
        throw new Error(
          "Exit receipt does not match the reviewed wallet call.",
        );
      const all = await api.query.system.events.at(blockHash),
        events = (all as unknown as EventRecord[]).filter(
          (e) =>
            e.phase.isApplyExtrinsic &&
            e.phase.asApplyExtrinsic.toNumber() === index,
        );
      if (
        !events.some(
          (e) =>
            String(e.event.section) === "system" &&
            ["ExtrinsicSuccess", "ExtrinsicFailed"].includes(
              String(e.event.method),
            ),
        )
      )
        return { outcome: "unknown" };
      outcome = decodeBatchEvents(events).success ? "succeeded" : "failed";
    }
    return {
      outcome,
      operationId,
      scope: structuredClone(scope),
      callHash,
      transactionHash,
      blockHash,
      blockNumber: Number(header.number.toString()),
      extrinsicIndex: index,
      innerDispatchVerified: true,
      ...(observed
        ? {
            observedProposal: structuredClone(
              pending.details!.multisig!.timepoint!,
            ),
          }
        : {}),
    };
  }
  return {
    read,
    prepareRevocation,
    prepareConversion,
    prepareFrozenConversion,
    prepareFeePayment,
    receipt,
    wrapMultisig: (
      scope: ExitScope,
      prepared: PreparedNativeExit,
      config: { signatories: string[]; threshold: number },
      assertCurrentFlow: () => void,
      existing?: PendingMultisigOp,
    ) =>
      wrapMultisigExit(
        api,
        scope,
        prepared,
        config,
        assertCurrentFlow,
        existing,
      ),
    prepareCancellation: (
      scope: ExitScope,
      pending: ExitPending,
      assertCurrentFlow: () => void,
    ) => prepareExitCancellation(api, scope, pending, assertCurrentFlow),
    verifyApproval: (
      pending: ExitPending,
      transactionHash: string,
      blockHash: string,
    ) => verifyExitApproval(api, pending, transactionHash, blockHash),
  };
}
