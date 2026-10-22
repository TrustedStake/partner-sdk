import {
  createPartnerClient,
  initialAllocationMessage,
} from "../../dist/browser.js";
import {
  mockService,
  sessionId,
  token,
  address,
  genesisHash,
  sha256,
} from "./mock.mjs";
const mock = mockService(
  new URLSearchParams(location.search).get("scenario") === "repair",
  new URLSearchParams(location.search).get("scenario") === "renew",
);
const stored = new Map(); // Demo only. Supply tab-owned durable storage for a real integration.
const client = createPartnerClient({
  fetch: mock.fetch,
  baseUrl: "/bridge",
  allocationBaseUrl: "/rebalance",
  storage: {
    getItem: (k) => stored.get(k) ?? null,
    setItem: (k, v) => stored.set(k, v),
    removeItem: (k) => stored.delete(k),
  },
  now: Date.now,
  sha256,
  sameWallet: (a, b) => a === b,
  readable: false,
});
const access = await client.open(sessionId, token);
const wallet = {
  signerAddress: address,
  managedWalletAddress: address,
  genesisHash,
  assertCurrentFlow() {},
  signer: { signRaw: async () => ({ signature: "0x" + "ab".repeat(64) }) },
}; // Mock signer. No wallet popup or transaction.
const session = client.session(access, wallet, mock.chain);
const button = document.querySelector("#next"),
  detail = document.querySelector("#detail"),
  heading = document.querySelector("#heading"),
  error = document.querySelector("#error");
let step =
  new URLSearchParams(location.search).get("scenario") === "renew"
    ? "renew"
    : "review";
let reviewed = await session.review();
function render() {
  const states = {
    review: [
      "Join Agentic",
      "Review the strategy and continue with your wallet.",
      "Join strategy",
    ],
    renew: [
      "Approval expired",
      "The previous rebalance never started. Renew approval for one hour; your membership stays active.",
      "Renew initial rebalance approval",
    ],
    rebalance: [
      "You joined Agentic",
      "Your membership is active. Approve the first rebalance when you’re ready.",
      "Sign for initial rebalance",
    ],
    queued: [
      "Initial rebalance",
      "Your initial rebalance is waiting to start.",
      "Check progress",
    ],
    complete: [
      "You’re all set",
      "Your initial rebalance is complete.",
      "Back to demo partner",
    ],
  };
  const state = states[step];
  heading.textContent = state[0];
  detail.textContent = state[1];
  button.textContent = state[2];
  document
    .querySelectorAll("[data-step]")
    .forEach((el) =>
      el.setAttribute(
        "aria-current",
        el.dataset.step === step ? "step" : "false",
      ),
    );
}
button.addEventListener("click", async () => {
  button.disabled = true;
  error.textContent = "";
  try {
    if (step === "review") {
      const snapshot = await session.reconcile();
      reviewed = await session.review();
      if (snapshot.context.initialAllocation?.status === "repair_required")
        await session.completeSetup(reviewed);
      else {
        const anchor = await session.ensurePermissions(reviewed);
        await session.register(reviewed, anchor);
      }
      step = "rebalance";
    } else if (step === "renew") {
      await session.renewAllocation(true);
      step = "queued";
    } else if (step === "rebalance") {
      await session.allocate(true);
      step = "queued";
    } else if (step === "queued") {
      const job = await session.allocationStatus();
      detail.textContent = initialAllocationMessage(job);
      if (job.status === "completed" || job.status === "no_op")
        step = "complete";
      else return;
    } else {
      location.reload();
      return;
    }
    render();
  } catch (e) {
    error.textContent =
      e instanceof Error
        ? e.message
        : "Unable to continue. Reconcile before retrying.";
  } finally {
    button.disabled = false;
  }
});
render();
