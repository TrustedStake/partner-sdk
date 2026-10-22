import type { SubmittableExtrinsic, Signer } from "@polkadot/api/types";
import { exitBeforeBroadcast } from "../exit-submission.ts";
import type { ExitSubmitter } from "../exit-browser.ts";
/** Explicit host action only. Separates wallet signing from broadcast so rejection cannot strand a false unknown transaction. */
export function createExitWalletSubmitter(
  signerAddress: string,
  signer: Signer,
  assertCurrentFlow: () => void,
  timeoutMs = 120000,
): ExitSubmitter {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 300000
  )
    throw new Error("Invalid wallet observation timeout.");
  return async (transaction, assertCurrent, onSigned) => {
    const tx = transaction as SubmittableExtrinsic<"promise">;
    try {
      assertCurrentFlow();
      await assertCurrent();
      if (
        !tx ||
        typeof tx.signAsync !== "function" ||
        typeof tx.send !== "function"
      )
        throw new Error("A supported unsigned transaction is required.");
      await tx.signAsync(signerAddress, { signer, era: 64 });
      assertCurrentFlow();
      await assertCurrent();
      // No send has occurred: a failed guard/storage write is proven pre-broadcast.
      onSigned(tx.hash.toHex());
    } catch (error) {
      throw exitBeforeBroadcast(error);
    }
    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | undefined,
        finished = false;
      const finish = (
        error: unknown,
        value?: { transactionHash: string; blockHash: string },
      ) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe?.();
        if (error) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "Transaction status is unknown. Reconcile the recorded hash before another action.",
            ),
          ),
        timeoutMs,
      );
      // Any error after invoking send is uncertain, regardless of provider wording.
      try {
        Promise.resolve(
          tx.send((result) => {
            if (result.status.isFinalized)
              finish(null, {
                transactionHash: tx.hash.toHex(),
                blockHash: result.status.asFinalized.toHex(),
              });
          }),
        ).then(
          (stop) => {
            unsubscribe = stop;
            if (finished) stop();
          },
          (error) => finish(error),
        );
      } catch (error) {
        finish(error);
      }
    });
  };
}
