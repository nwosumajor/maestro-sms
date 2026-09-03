// =============================================================================
// Hashing a whole roll without stopping the platform
// =============================================================================
// bcrypt is deliberately slow, and `bcryptjs` is PURE JAVASCRIPT: one hash is an
// uninterruptible ~80 ms of CPU on the single Node thread that serves every
// tenant. That is fine for one account and fatal for a batch, and the shape the
// bulk importers used made it as bad as it can be:
//
//     await Promise.all(rows.map((r) => bcrypt.hash(...)))
//
// queues every hash before the loop gets a turn. MEASURED, 20 hashes: 1,573 ms
// during which the event loop ticked ONCE where ~157 were due. So a 500-pupil
// student import — the thing a school does on its FIRST DAY — blocked every
// other school's requests for about fifty seconds, and a 1,000-row batch, which
// the boundary permits, for about a hundred. Health checks included.
//
// Sequential with an explicit yield costs exactly the same CPU and hands the
// loop back every ~80 ms: measured, the same 20 hashes tick 20 times. A caller
// waits no longer; everybody else stops waiting.
//
// // GOTCHA: awaiting a resolved promise only drains MICROTASKS. `setImmediate`
// is what lets pending I/O — another tenant's request — actually run.
// =============================================================================

import bcrypt from "bcryptjs";

export const BCRYPT_ROUNDS = 10;

/** Hash one secret per item, sequentially, yielding to the event loop between. */
export async function hashEachWithoutBlocking<T, R>(
  items: T[],
  secretOf: (item: T) => string,
  build: (item: T, secret: string, passwordHash: string) => R,
): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) {
    const secret = secretOf(item);
    out.push(build(item, secret, await bcrypt.hash(secret, BCRYPT_ROUNDS)));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return out;
}
