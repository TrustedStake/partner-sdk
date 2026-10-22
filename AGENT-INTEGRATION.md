> Local unpublished next.5 candidate. Native exit requires the matching unreleased API changes; see [NATIVE-EXIT.md](./NATIVE-EXIT.md). Do not treat this tree as a live-service release.

# TrustedStake native integration: agent quickstart

Package: `@trustedstake/partner-sdk@0.1.0-next.5`. Prerelease,
ESM JavaScript plus TypeScript declarations. The browser/core/server entries need no framework or runtime dependencies. The optional `/polkadot` entry uses the declared Polkadot peer dependencies.
Use this guide with the matching tarball and checksum. Use only a release published by the TrustedStake SDK repository or registry owner.

## Give your coding agent this task

> Integrate the supplied TrustedStake SDK into our existing app. Read this guide,
> README.md, the emitted declarations, examples/agent-quickstart.ts and
> examples/server-bridge.ts and examples/multisig-quickstart.ts first. Build a native catalog/join/status flow, keeping
> partner credentials on our server. Render current fee terms before acceptance,
> bind wallet signing to account/network/session, and make initial rebalance a
> separate approval. Reconcile ambiguous outcomes instead of retrying mutations.
> Start with the bundled mock. Report unsupported features and qualification gaps;
> do not provision credentials, publish, deploy, send transactions, or contact
> users as part of implementation.

## Inputs the integration owner must provide

Use a provisioned partner ID, allowed strategy references, configured return
destination IDs and approved site origins. Obtain the intended API HTTPS origin
and network/genesis hash from the release owner. Do not guess production URLs or
create a second credential. Allocation uses an existing scoped partner credential
through a server secret-store callback. The host also supplies customer/session
authorization, rate limits and site-origin/CSRF checks.

The browser supplies fetch, tab-scoped storage, a millisecond clock, SHA256 returning
64 lowercase hex characters, validated account comparison, and the current wallet
adapter. `Wallet.assertCurrentFlow()` must reject changes to account, signer,
network/genesis, session or UI action, including while a signing prompt is open.
Do not replace it with a no-op. The `Wallet` and `ChainAdapter` declarations are
the precise adapter interfaces.

## Install the review artifact

Verify the supplied checksum, then install the file without registry access:

```sh
shasum -a 256 -c trustedstake-partner-sdk-0.1.0-next.5.tgz.sha256
npm install --offline --ignore-scripts ./trustedstake-partner-sdk-0.1.0-next.5.tgz
```

Commit your lockfile. Import browser APIs from `@trustedstake/partner-sdk`, protocol
helpers/types from `/core`, and the bridge from `/server` in server code only. The
package targets ES2022 and Fetch/Web APIs; qualify your host runtime accordingly.
The optional `/polkadot` entry supplies concrete proposal, finalized recovery and authorization-deposit helpers. It requires compatible `@polkadot/api`, `@polkadot/types`, `@polkadot/util` and `@polkadot/util-crypto` packages already used by your host; see package.json for supported ranges. Your host supplies its wallet signer, guarded finalized submitter and ownership/storage policy. CommonJS is not supplied.

Run the packaged mock from your app directory:

```sh
node node_modules/@trustedstake/partner-sdk/examples/native-ui/server.mjs
```

Open `http://127.0.0.1:4360/packages/partner-sdk/examples/native-ui/`.
Add `?scenario=repair` for existing-member setup or `?scenario=renew` for expired approval renewal. It uses synthetic
signatures and in-memory chain/server data. It resets on reload and cannot certify
real signing, chain behavior or durable recovery.

## Mount the server routes

Adapt `examples/server-bridge.ts` to your existing Fetch-compatible HTTP framework:

| Local path | Upstream route family | Credential |
| --- | --- | --- |
| `/bridge/*` | `/api/v1/partners/*` | Public or bounded session capability |
| `/rebalance` and `/rebalance/*` | `/api/v1/membership/initial-allocation` | Existing scoped server Bearer credential |
| `/multisig/{challenge,resolve,verify}` | `/api/v1/multisig/auth/{challenge,resolve,verify}` | No partner credential; required host customer authorization |

`createServerBridge` validates the allowlisted route and body, invokes your required
authorization callback, and adds the private credential only for allocation.
Implement customer authorization in that callback for each resource and wallet.
The browser transport omits cookies by default: if your host authenticates its
bridge with a customer cookie, supply a wrapper around fetch that explicitly adds
the appropriate same-origin session authentication and CSRF mechanism, and test
both paths. Never authorize merely because a request came through CORS or carries
a session ID. Do not forward arbitrary customer-supplied upstream URLs or secrets.

Keep capability tokens, signing messages, signatures and contact data out of
telemetry, URLs and support bundles. The bounded SDK error exposes status/code;
render generic safe customer text instead of dumping response objects. Contact
sharing and invoice reminders are separate private app APIs, not SDK features.

## Implement the native flow

1. Create one client/controller owner per wallet and session. Use
   `client.catalog(partnerId)`, then `client.launch(partnerId, strategyRef,
   idempotencyKey, returns)` or `launchInvite(launchId, idempotencyKey, returns)`.
   Keep the launch idempotency key stable if the response is lost.
2. Read the launch token from the fragment and remove the fragment from browser
   history before requests or analytics. Call `client.open(sessionId, launchToken)`.
   Never put the private partner key in browser code.
3. Construct `client.session(access, wallet, chainAdapter)`. Call `review()` and
   render the returned current fee policy and disclosure. Stop and re-review if
   terms change. Use `examples/agent-quickstart.ts` for the typed call sequence.
4. On explicit Join, call `ensurePermissions(reviewed)` and then
   `register(reviewed, anchor)`. Chain setup is separate from registration.
   The chain adapter reads one finalized block, checks exact proxy type, zero delay
   and fee consent, submits only missing reviewed calls atomically, verifies inner
   dispatch success, and re-reads at the receipt or a finalized descendant.
5. Returning members use `verifyWallet()` to prove identity and obtain fresh scoped
   state. If the server requests setup repair, review terms and call
   `completeSetup(reviewed)`. Preserve the server's original birth anchor. Never
   leave/rejoin to repair setup or infer membership from an arbitrary other app.
6. Show a separate initial-rebalance approval. Only that action calls
   `allocate(true)`. Read `allocationStatus()` for updates. Membership registration
   by itself is not permission to start trading.
7. After interruption, call `reconcile()`. Keep unresolved journal entries blocked.
   If access was lost, use read-only `client.recover(sessionId, wallet)` and obtain
   a fresh partner launch for action access. Do not manufacture capabilities.

| Receipt status | Display/action |
| --- | --- |
| `queued`, `running` | Pending; retry bounded reads, never label completed |
| `completed` | Completed with authoritative successful-operation evidence |
| `no_op` | Finished without required trades |
| `blocked`, `cancelled` | Explain blocker; membership remains separate |
| `needs_review` | Stop automatic mutation; preserve support correlation ID |

One controller deduplicates identical concurrent calls in that controller only.
Cross-tab ownership is your application's responsibility. No mutation has automatic
retries. Storage write failure stops submission. Protect stored session/read tokens
from XSS; do not include the raw storage journal in a support export.

## Compatibility and release limits

The package pins Partner API v1 and initial-allocation v1. Readable signing is
schema v2 with v1 semantic intent. There is no API-version negotiation endpoint.
Missing mutation capabilities fail closed; unknown feature flags grant no authority.

Native renewal and multisig recovery are included in this prerelease. Invoice reminders and
member contacts remain separate private app APIs. A signer different from the
managed wallet still requires verified API authorization; a TypeScript identity
does not establish it. The optional `session.continuation()` method remains an
explicit host choice and is never invoked by the SDK to replace these flows.
This repository is the source for this SDK release.

## Renew an expired approval in your interface

Read fresh `allocationStatus()` and render `initialAllocationMessage(job)`.
`canRenewInitialAllocation(job)` permits only `blocked` + `authorization_expired`,
with no start time and zero successful/failed operations. After explicit user
acceptance call `session.renewAllocation(true)`. The SDK obtains and validates a
new challenge bound to the old correlation ID and exact renewal consent, signs
once, and records the new request ID before submission. It does not extend an
already-started or uncertain job. The API independently checks evidence, authority,
membership generation and fee policy under its lock.

If the response is lost, reconcile. The old expired job is not proof of renewal
acceptance: the new correlation ID must match. No automatic renewal or mutation
retry occurs. An expired read token can be recovered from freshly authenticated
session context; it cannot create another approval.

## Multisig in your interface

Use `examples/multisig-quickstart.ts` and the `/polkadot` exports. This code uses
an injected `ApiPromise` and wallet submitter, with no React, extension-specific
package or hosted page. Configure `multisigPrefix: '/multisig'` in your server bridge.
The browser `createAuthorizationTransport` sends bounded same-origin requests.

For executable proposals, `createMultisigProposal` records reviewed call bytes,
network and runtime. `prepareMultisigAction` reads finalized multisig storage and
prepares either an approval, threshold-completing execution, or original-depositor
cancellation. Render the decoded call and action to the user before signing.
`submitPreparedMultisigAction` writes `needs_review` to your durable store before
calling your submitter and records returned receipt hashes without claiming success.
Your submitter must call the supplied `assertCurrent` immediately before wallet
signing, and confirm finalized dispatch success. Preserve the saved operation on
any exception; do not construct a replacement after an ambiguous submission.

Use `getMultisigStorageEntry` and `inferPendingOpStatus` to refresh evidence.
`exportMultisigProposal` and `importMultisigProposal` support another signer/device;
files are public recovery data, not authority. Import verifies derivation, call
hash, network and creation-block runtime; approval also checks the current runtime.
A vanished proposal is unresolved until its exact finalized receipt is verified.
Cancellation remains available to the depositor after a runtime upgrade.

For a signer's API authorization, `createAuthorizationDeposit` obtains a
server-issued challenge and prepares **hash-only** `approveAsMulti`. After explicit
approval use the same journaled submit helper, then `verifyAuthorizationDeposit`.
The latter saves finalized timepoint/depositor evidence before HTTP verification.
After interruption, resume that proof; do not create another deposit. Export/import
it with `exportAuthorizationProof` / `importAuthorizationProof`. An expired proof
can be resolved and reclaimed with `prepareAuthorizationCancellation`, by its
original depositor. Absence alone never proves a refund. Authorization hashes are
rejected by executable proposal preparation and must never be passed to `asMulti`.

Keep one mutation owner per wallet/operation across tabs. The submit helper blocks
reuse of the same prepared action object, but server/chain authority and your
persistent ownership policy remain necessary. These primitives do not acquire a
wallet extension or perform financial work until your host explicitly invokes its
submitter in response to the user's reviewed action.

The browser controller does not enumerate all user memberships. Use the separately
provisioned partner membership server API for authorized partner button state.
The SDK never implements a replacement trading executor.

## Acceptance before a partner release

Automate account/network switches during signing; stale fee terms; signature
rejection/expiry; duplicate clicks; storage failure; lost accepted responses;
permission-setup interruption; existing-member repair; expired session recovery;
queued/running/terminal status handling; denied customer authorization; credential
exclusion; and bridge body/route bounds. Compile the included typed examples against
the actual installed tarball. Ensure server imports/credentials are absent from
browser bundles.

Local package tests and mocked UI/chain tests qualify code paths, not an operational
partner installation. The release owner must approve the current API/UI versions,
origin/return configuration and scoped existing credential, then separately
authorize real wallet/chain qualification. Before a live partner integration, preserve the exact package checksum and agreed API version in your handoff. Registry availability alone does not qualify live financial execution.

## Same-origin tab ownership and concrete permission reads

When multiple tabs can open the same wallet/session, inject a coordinator and a
shared **public pending journal**, while leaving session/read capabilities in
`sessionStorage`. Use the same normalized wallet/network/session scope in every tab:

```ts
import {createWebLocksCoordinator} from '@trustedstake/partner-sdk';
const coordinator = createWebLocksCoordinator(navigator.locks, stableScope);
const dependencies = {
  // Existing fetch, clock, hashing, bridge URLs, identity adapter, readable mode...
  storage: sessionStorage,
  journalStorage: localStorage,
  coordinator,
};
```

The coordinator requests an exclusive lock with `ifAvailable:true`. A conflicting
tab fails immediately; it never queues a later wallet prompt. Closing the owning
tab releases the browser lock but leaves its public pending journal intact, so the
next action must reconcile before retrying. Shared journal records contain no
signature, signing message, session token or read token. Browser storage failure
stops submission. Do not use an expiring lease or steal a lock while a wallet
prompt may still be active. If Web Locks is unavailable, enforce one owner in the
host or stop; the helper does not silently downgrade. This does not coordinate
other origins or distinct sessions, and backend/chain replay controls still apply.
Multisig hosts should use the same coordinator around prepare/submit/reconcile and
save public operations in their durable shared store.

`createPolkadotChainAdapter(api, guardedSubmitter)` is now supplied in `/polkadot`.
It reads proxy, fee consent and timestamp at one canonical finalized block, uses
`realPaysFeeConsentV1` when advertised (never falls back to legacy on missing/false
V1), and prepares only the exact missing reviewed calls in `utility.batchAll`.
After submission it checks canonical finality, exact transaction inclusion, scoped
outer/inner dispatch events, then permission state at the receipt block. A future,
forked, absent, failed or malformed receipt cannot complete setup. The submitter
still belongs to your wallet integration; for a managed multisig it must return
only after the actual permission call executes, not after one signer's approval.
Use the injected `assertCurrent` immediately before signing. No automatic retry is
performed if submission or receipt delivery is uncertain.
