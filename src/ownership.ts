/** Host-injected mutation ownership. A rejected lock must never queue a later signing prompt. */
export interface MutationCoordinator {
  run<T>(action: () => Promise<T>): Promise<T>;
}
/** Web Locks are same-origin and released on tab close. Never use a steal/expiring-lease fallback. */
export function createWebLocksCoordinator(
  locks: Pick<LockManager, "request">,
  scope: string,
): MutationCoordinator {
  if (
    !locks ||
    typeof locks.request !== "function" ||
    !scope ||
    scope.length > 512
  )
    throw new Error(
      "Cross-tab ownership requires Web Locks and a stable wallet/network/session scope.",
    );
  return {
    run: async <T>(action: () => Promise<T>): Promise<T> =>
      await locks.request(
        `trustedstake:sdk:mutation:${scope}`,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error(
              "Another tab owns this operation. Reconcile after it finishes.",
            );
          return action();
        },
      ),
  };
}
