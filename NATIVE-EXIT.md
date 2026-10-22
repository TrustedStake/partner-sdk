# Native exit — local next.5 candidate

This candidate has not been published or qualified against live services. Published next.4 does not include this lifecycle. Enable it only after deploying the matching owner-exit API and qualifying the intended partner, wallet and network. The join API alone is insufficient. No new backend schema or partner private credential is needed for these owner-exit routes; an existing partner record, correct network and wallet authorization remain required.

## User flow

Keep the customer's UI native and in context. Authenticate ownership once with an explicitly requested wallet **message**. Read `refresh()` automatically at a bounded interval. Render `nextAction` as one contextual action, with technical details optional. Never execute it automatically.

1. `reviewFees()` retrieves the exact current obligations with a wallet message. If required, show recipients, TAO amounts, expiry and the fixed payment reference; `prepare('pay-exit-fees')` then `submit()` opens the wallet for only that payment. Threshold approval is not payment execution.
2. `endMembership()` signs a generation-bound API message. It stops only that membership generation. It cancels matching never-started initial jobs; running or unknown chain work remains pending. An interrupted API response is reconciled by owner reads. A repeat of the same generation is idempotent and never sells stake.
3. Once work is quiescent and no other membership needs this delegate, review `prepare('revoke-authority')` and submit removal of exactly this delegate's zero-delay Staking proxy. Shared or ambiguous legacy memberships are held for review. No remove-all or global fee-consent revocation is performed.
4. Optionally choose holdings, slippage basis points and partial-fill policy, then `prepare('convert-alpha', selection)`. Render every executable **and excluded** position and each enforced minimum. `submit()` converts selected unlocked stake into liquid TAO in the same wallet. It does not transfer funds elsewhere. Residual stake is never labelled complete withdrawal. Root stake has no AMM price limit; non-root calls require a nonzero on-chain protected limit. Unsupported runtime calls, stale quotes, zero-rounded limits and inadequate simulated proceeds fail closed. Fees and chain inclusion fees are distinct.

A user can stop after ending membership/removing authority and keep the alpha. Do not imply conversion is mandatory or automatic. Membership, authority, conversion and external transfer are separate outcomes. External transfers are not part of this controller.

## Host setup

See the separate browser `examples/native-exit-quickstart.ts` and server `examples/native-exit-server.ts` examples. Root exports provide the framework-neutral API/controller; `/server` exposes `createNativeExitBridge`; optional `/polkadot` provides the concrete adapter and `createExitWalletSubmitter`. Only that optional entry needs the declared Polkadot peers. Do not import the server example into browser bundles.

Supply the verified partner UUID, strategy UUID/table, delegate, correct genesis and current authorized wallet/signer. The owner API resolves an unambiguous generation or requires the saved generation for legacy ambiguity. Do not guess a delegate or use an individual signer in place of the multisig member wallet. `sameWallet` must validate and normalize AccountIds. `assertCurrentFlow` must reject account/network/intent changes, including during wallet review. Recreate the controller and submitter after signer switches.

Mount `/exit/*` with mandatory customer/resource authorization, origin/CSRF protection and rate limits. The bridge forwards only explicit exit challenge/context, signed cessation and fee quote/receipt routes. It omits upstream cookies, refuses redirects and cannot accept a private partner key. Browser fetch omits cookies; hosts using cookie authentication must deliberately add their same-origin authentication/CSRF wrapper and test both authorized and denied paths. Exit read access lasts 15 minutes and must be explicitly renewed with an ownership message. Paused joins do not disable authorized recovery.

## Multisig and interruptions

Pass exact signatories and threshold. First approval persists a public proposal and shows signer progress; the next authorized signer uses `prepareContinuation()`. The second signer re-reviews the **same** call and its fixed protected minimums. Expired fee quotes, changed runtime, stale holdings or shared-proxy conflicts cannot silently replace it. Only the original depositor can explicitly cancel a verified proposal; cancellation never pays, sells or removes authority.

Use durable wallet/network-bound journal storage and a non-queuing cross-tab coordinator. Web Locks cover tabs on one origin. Distinct people/browsers need host-provided access-controlled persistence/handoff of the public pending record; localStorage alone is not cross-device synchronization. No file export/import is required in the normal flow. Never share read capabilities or signatures in that record. An untrusted record is not proof: the adapter verifies account derivation, call hash, runtime, live proposal and canonical events again.

The supplied submitter journals the signed hash before broadcasting. Wallet rejection proven before send permits fresh review; any error after send remains unknown. Reconcile the exact hash/block from the wallet/provider. Submitted unknowns remain blocked even when balances changed manually. A verified awaiting-signers proposal may be settled from another signer's exact finalized execution/cancellation receipt, bound to the saved creation timepoint and inner call; it is not inferred from a vanished proposal. No arbitrary historical match or automatic block scan is used. If inclusion location is unavailable, retain the journal and obtain it through normal wallet/explorer history; do not retry the financial call.

Fresh manual holdings/proxy changes are reflected in read-only snapshots. Confirmed partial fills leave remaining positions visible. Failed dispatch clears only the verified failed attempt and requires a fresh explicit quote; no automatic increase in slippage or partial-fill permission. Existing ambiguous legacy origins/shared dependencies and unresolved worker effects need operator reconciliation or the existing app's self-service flow. They are not permission to rejoin or replay.

## What local qualification proves

Node tests compose the real SDK controller/API parser/bridge and concrete Polkadot adapter against synthetic service/RPC/event fixtures. Separate private API tests exercise real signatures and PostgreSQL transactions. The packaged browser example tests actual emitted modules, storage and UI orchestration with synthetic service/chain adapters. These do not prove live worker quiescence, chain runtime behaviour, fee settlement or attended hardware/extension signatures. Before production use, qualify the exact deployed API, intended partner configuration, correct chain RPC/runtime, ordinary and multisig wallet approvals, receipt discovery and the host's cross-device handoff. No secrets or customer data are supplied with this example.

Run the synthetic browser example after building:

```sh
node examples/native-exit/server.mjs
# http://127.0.0.1:4361/  or  /?multisig=1
```

Every confirmation is simulated; the demo has no extension, live network, valid on-chain signing identity or backend authentication. Its CSP blocks outbound connections. Real integrations must replace its entire mock API/chain model with the supplied concrete API/chain adapters and host authorization. Demo storage is public synthetic state; do not paste customer journals or credentials into it.
