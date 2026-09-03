/**
 * A notifications double that has BOTH shapes, because every real
 * `NotificationService` does.
 *
 * A fixture with only `enqueue` models a system that cannot exist, and it is why
 * three fleet sweeps could be rewritten to write once per GROUP and have their
 * suites go green while the service threw "enqueueMany is not a function" into
 * its own best-effort catch. `enqueueMany` fans into the same per-recipient spy,
 * so an assertion still asks WHAT somebody was told rather than which call told
 * them.
 */
export function notificationsStub() {
  const enqueue = jest.fn().mockResolvedValue({ id: "n-1" });
  const enqueueMany = jest.fn((actor: unknown, to: string[], input: Record<string, unknown>) => {
    // The real enqueueMany ISOLATES per-recipient failures and reports counts;
    // a fan that let one rejection escape would crash the worker instead.
    let failed = 0;
    for (const recipientId of to) {
      try { const r = enqueue(actor, { ...input, recipientId }); if (r?.catch) r.catch(() => { failed += 1; }); }
      catch { failed += 1; }
    }
    return Promise.resolve({ created: to.length - failed, failed });
  });
  const notifyHolders = jest.fn().mockResolvedValue(0);
  return { enqueue, enqueueMany, notifyHolders };
}
