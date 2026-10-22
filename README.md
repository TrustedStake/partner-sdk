> next.5 is a prerelease. Native exit requires the matching owner-exit API and qualification of the intended host, wallet and network; see [NATIVE-EXIT.md](./NATIVE-EXIT.md). Package availability alone does not establish live-service readiness.

# TrustedStake partner SDK

`@trustedstake/partner-sdk` **0.1.0-next.5**, a prerelease SDK. This repository contains only the partner integration client, optional chain adapter, examples and tests. Its framework-neutral entries have no runtime dependencies, React requirement, built-in wallet extension or browser credential. The optional `/polkadot` entry uses declared optional Polkadot peers. It is not a production release or an authorization to trade.

## Entry points

| Entry | Purpose |
| --- | --- |
| `@trustedstake/partner-sdk` | Browser client, session controller and core exports |
| `@trustedstake/partner-sdk/core` | Wire parsers, current fee review, exact signing, allocation receipts and optional chain adapter types |
| `@trustedstake/partner-sdk/server` | Bounded Fetch Request/Response bridge; import only on a server |
| `@trustedstake/partner-sdk/polkadot` | Optional concrete multisig action preparation, finalized recovery and authorization-deposit helpers |

Build from this repository with Node 22 and npm 11.9.0 (development tooling only):

```sh
npm exec --yes --package=npm@11.9.0 -- npm ci --ignore-scripts
npm run build
npm test
npm run typecheck
```

The package uses TypeScript 5.9 relative-import rewrite mode; emitted browser modules use `.js` imports. The package emits ESM JavaScript and declarations into its ignored `dist/` folder. The framework-neutral entries remain dependency-free; install compatible Polkadot peers only when importing `/polkadot`. Host code supplies `fetch`, clock, SHA256, storage, signer, wallet identity comparison and optionally a chain adapter. Native browser Web Crypto can implement SHA256; use audited SS58 normalization when accepting different address prefixes. The default example uses exact equal addresses and synthetic accounts.

## Integrating a native UI

```ts
import { createPartnerClient } from '@trustedstake/partner-sdk';

const client = createPartnerClient({
  fetch: window.fetch.bind(window),
  baseUrl: '/bridge',
  allocationBaseUrl: '/rebalance',
  storage: window.sessionStorage,
  now: Date.now,
  sha256,       // async (text) => lowercase SHA256 hex without 0x
  sameWallet,   // validated SS58/account comparison
  readable: true,
});

// Extract launchToken from the fragment and remove the fragment from browser history
// before starting requests. Never put credentials in queries, logs or analytics.
const access = await client.open(sessionId, launchToken);
const session = client.session(access, wallet, finalizedChainAdapter);
const reviewed = await session.review();
// Render reviewed.context, including its CURRENT fee policy and disclosure.
// Wait for explicit user acceptance before calling a mutation.
const from = await session.ensurePermissions(reviewed);
await session.register(reviewed, from);
// Render “Sign for initial rebalance”, with a separate explicit approval.
await session.allocate(true);
// Queue acceptance is not completion. Poll/read receipts, or revisit the session.
const receipt = await session.allocationStatus();
```

`wallet.assertCurrentFlow()` must throw if the selected account, signer, network/genesis, authorized session or UI intent changed. The SDK calls it around asynchronous reads and signatures. Never implement it as an empty function outside the mock example. `signRaw` signs the exact issued bytes. The SDK validates action, method, route, session, resource, addresses, network/genesis, nonce, expiry, body hash and readable presentation before signing, then checks expiry again after approval. The API remains responsible for signature verification, authorization, one-use challenges and atomic replay prevention.

For returning members, `verifyWallet()` performs a separate identity proof and re-reads authoritative membership. Membership found elsewhere does not give this partner access to that membership. An active member bypasses another registration unless the server explicitly requests setup repair. `completeSetup(reviewed)` verifies existing membership, repairs missing Staking permissions and confirms the server's original birth anchor when required. It never leaves and rejoins or invents a new birth timestamp. Changed current fee terms stop the operation until the new disclosure is reviewed. `confirmation_required` requires finalized permissions; `repair_required` also requires the unexpired original server anchor.

Default partner visibility uses the maintained `partner_membership` scope, only when the session supports it. The client refuses the legacy broad scope. The API scopes origin/generation and ends partner visibility when that membership ends. It does not grant a partner signing or transfer authority. Partners must use the maintained backend membership API for their server-side button state; this browser controller does not enumerate unrelated memberships.

## Optional chain adapter

Implement `ChainAdapter` when the native UI owns permission transactions; omit it for catalog, wallet proof, recovery and receipt reads. The SDK intentionally does not implement the backend allocation/trading engine or build allocation transactions in the browser.

- Read proxies, Staking proxy type, delay **0**, `realPaysFee`, block hash/height and chain timestamp together at **one finalized block**. Missing or unreadable state must throw, never become permission=true.
- Confirm managed wallet, strategy proxy and genesis. An existing zero-delay Staking proxy avoids a duplicate addProxy. `permissionPlan` adds only missing Staking/fee consent calls, never transfer or Root permissions.
- Submit the reviewed calls using atomic `batchAll`, with the original signer and dispatch-success verification. Return finalized transaction/block hashes. Re-read at the receipt block or a verified finalized descendant; never return an older or unrelated fork.
- The SDK requires permissions to be verified after submission. A checkpoint is only a recovery hint. It never proves permission, membership or allocation completion.

`src/chain.ts` is the optional chain-library seam. Use `/polkadot` for the included permission adapter or supply a compatible adapter with finalized receipt verification and a guarded signer. No Polkadot runtime is bundled.

## Resume and retries

Use **one session controller/owner per wallet/session**. Concurrent repeated calls with the same arguments share one promise; a different wallet action fails while an action is running. This is not a distributed/cross-tab lock. Keep a tab-scoped store and coordinate tabs with your host's lock policy if sharing durable storage. Server locks/replay protection remain required.

The SDK writes a versioned, wallet/network/strategy-bound journal **before submitting** a permission transaction, registration or allocation approval. Storage failure stops submission. It stores no signatures or challenge message. It separately stores session/read capabilities; protect that storage from XSS and do not copy it into support bundles.

After an interruption call `reconcile()`. It reads fresh server context, membership and finalized permissions. It clears a pending operation only when corresponding authoritative evidence exists. A lost or malformed response is not permission to retry. It does not repeat trades, accept a submitted/queued status as financial success, or silently clear `needs_review`. An unresolved operation stays blocked for review. A wallet rejection before registration/allocation submission can be retried after a fresh challenge. A permission-adapter rejection can be indistinguishable from a broadcast; reconcile it conservatively.

If public registration accepted but its rotated action capability was lost, use read-only `client.recover(sessionId, wallet)` and open a fresh partner link to verify the existing membership. Recovery does not manufacture action access. `session.continuation()` returns a validated hosted continuation when supported. Keep idempotency keys stable when repeating a launch after a lost launch response. Polling reads may be retried; mutations have **no automatic retries**.

`allocate(true)` always requests its own durable server-issued approval. It requires a verified active membership and `initialAllocation.status=ready`. If the context already contains a job, it returns that receipt instead of signing another request. `queued`/`running` remain pending; `completed` and `no_op` are the successful terminal outcomes. `blocked`, `cancelled`, `needs_review` preserve membership and require explicit handling. Never build replacement trades for an uncertain job.

## Server bridge

See `examples/server-bridge.ts`. `createServerBridge` accepts injected fetch, a trusted HTTPS API origin, existing secret-store access and a **required** authorization callback. It forwards only maintained public/session and initial-allocation routes. There is no arbitrary proxy, credential-provisioning endpoint or browser API key.

Implement the callback using the partner's site-origin/CSRF checks, customer/session authorization, allowed wallet/resource mapping, rate limits and approved partner scope. The example checks site origin and JSON on POST, then delegates customer authorization to your host. Authorization is not supplied by CORS or the SDK. The bridge uses the existing scoped partner Bearer credential only for allocation; public/session routes use public access or the browser's bounded session capability. It never forwards cookies or upstream auth headers to the browser and refuses a response containing its private key. Do not bundle the server entry into your browser.

Browser requests use same-origin bridge paths, no-store, omitted cookies, no referrer and rejected redirects. Incoming/outgoing bodies are stream bounded. HTTP errors expose a bounded code/status, not an upstream body or private diagnostics. `onEvent` emits only redacted operation/outcome values; telemetry callback failure cannot change a financial outcome.

## Version and capability compatibility

The prerelease targets the maintained **Partner API v1** routes and the separate **initial allocation v1** API. Readable challenge presentation uses schema v2, with the v1 semantic intent; exact previously issued legacy messages remain supported when readable mode is disabled. Once readable is selected there is no JSON fallback after failure.

The server does not currently advertise a separate negotiated API-version field. This package exports `PARTNER_API_VERSION=1` and pins its routes; do not infer compatibility from the package version. Breaking wire changes require a new SDK version and qualification. Unknown feature strings are ignored for forward-compatible reads; missing `memberships:manage` or `initial-allocation:request` capabilities fail closed before mutations and require capability configuration and qualification before continuing. Legacy frame config with no features is read-only for this controller. There is no invented capability elevation.

## Run the safe native example

```sh
npm run build
npm run demo
```

Open `http://127.0.0.1:4360/packages/partner-sdk/examples/native-ui/`, or add `?scenario=repair` or `?scenario=renew`. This custom HTML/JS UI uses the built browser entry and an in-memory mock. It exercises join, existing-member Complete Setup, separate rebalance approval and queued/running/completed receipts. **No keys, real wallets, external fetches or real transactions.** It resets on reload and is not a durable-storage example. Replace the entire mock service/signer/chain and provide a real guarded integration before considering production use. The example remains a local mock, not production qualification.

## Verification and limits

Meaningful tests cover exact/substituted/expired/rejected wallet requests, account/network/resource changes, fee disagreement, original-anchor repair, duplicate clicks, lost accepted responses, interrupted proxy setup, unknown permissions, missing setup, existing queued jobs, allocation separation, bounded server routes and credential exclusion. The tests exercise client-side contracts and synthetic chain evidence, without production credentials or service access.

The included tests and mock demo do not qualify a partner's authenticated customer integration or real wallet/chain driver. Cross-tab ownership, production credentials, backend capability configuration and live acceptance remain the integration owner's responsibilities. No production financial execution is implied by a passing SDK test.

## Agent handoff and local distribution

Start with [AGENT-INTEGRATION.md](./AGENT-INTEGRATION.md) and the typed `examples/agent-quickstart.ts`. Build, then run `npm run test:package`. This creates a local tarball under `artifacts/`, checks its public entry points in a clean consumer, and compiles the included examples. It does not publish.

## Current renewal and multisig interfaces

`session.renewAllocation(true)` implements separate signed renewal for an expired,
never-started initial rebalance. It validates exact renewal consent and old
correlation ID, records the new request ID before submission and requires matching
fresh evidence after a lost response. It never renews automatically.

The optional `/polkadot` entry exposes the current release proposal importer/exporter,
finalized receipt/runtime checks, native approval/execution/cancellation preparation,
and server-bound authorization-deposit creation, resume and reclaim. Use
`examples/multisig-quickstart.ts`; detailed flow and signer/storage obligations are
in [AGENT-INTEGRATION.md](./AGENT-INTEGRATION.md). These APIs do not invoke hosted
continuation. The host supplies its guarded wallet submitter and explicit user action.

Set `multisigPrefix` on the bridge to enable only challenge/resolve/verify. No
partner credential is forwarded on those routes. The API still independently
verifies finalized proof and signer authority. There is no generic proxy or
credential-management route.

## Qualification limits

`createWebLocksCoordinator` and `Dependencies.journalStorage` support explicit
same-origin multi-tab ownership, with public pending records shared separately
from session/read tokens. Contending actions reject immediately, and a closed tab
cannot erase its pending operation. See the guide for the stable scope contract.

`createPolkadotChainAdapter` supplies concrete finalized permission reads, V1 fee
consent handling, atomic setup preparation, exact receipt/dispatch verification
and post-transaction permission checks. It takes the host's guarded finalized
submitter. These helpers are tested with deterministic mocked chain evidence;
actual wallet/customer-session/chain qualification remains outstanding.

## Source and license

The SDK source in this repository is available under [MIT](./LICENSE). Polkadot peers and development dependencies retain their own licenses; they are not bundled in the SDK tarball. The JavaScript package and this source repository expose the client integration protocol, not the TrustedStake backend or trading executor.

This is an explicit prerelease (`next`), not the stable `latest` release. GitHub release assets include the built tarball and SHA256 checksum. Verify that checksum before installing. Package availability does not authorize live transactions or establish a partner integration's production qualification.
