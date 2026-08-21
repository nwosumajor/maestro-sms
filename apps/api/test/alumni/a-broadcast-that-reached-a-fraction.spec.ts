// =============================================================================
// "It goes out to the alumni body" — to the ones with an account
// =============================================================================
// A broadcast is a NOTIFICATION, and a notification is addressed to a user
// account. `Alumnus.userId` is nullable precisely because a school records most
// alumni after the fact — the schema says so: "Optional link to the original
// student User (null if recorded after the fact)."
//
// The fan-out filtered `userId: { not: null }` and returned that count, and the
// screen said "Broadcast queued — it goes out to the alumni body in the
// background." So a school with fifty alumni on file and three linked accounts
// was told the broadcast had gone out, and never learnt that forty-seven people
// were not written to.
//
// The card above the button already said "Sends to alumni who have a linked
// account". The success message contradicted the card, and a success message is
// what people read.
//
// "Queued 3" and "queued 3, 47 have no account" are different facts, and the
// second is the one that makes somebody go and collect email addresses. Same
// reasoning the fee run applies when it reports what it skipped.
// =============================================================================

import { AlumniService } from "../../src/alumni/alumni.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(counts: { linked: number; unlinked: number }) {
  const count = jest.fn(({ where }: { where: { userId?: unknown; graduationYear?: number } }) =>
    Promise.resolve(where.userId === null ? counts.unlinked : counts.linked),
  );
  const tx = { alumnus: { count } } as unknown as TenantTx;
  const add = jest.fn().mockResolvedValue(undefined);
  const svc = Object.create(AlumniService.prototype) as AlumniService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
    audit: { record: jest.fn() },
    queue: { add },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  (svc as unknown as { log: unknown }).log = jest.fn().mockResolvedValue(undefined);
  return { svc, count, add };
}

const office: Principal = { schoolId: "A", userId: "admin", roles: ["school_admin"], permissions: ["alumni.manage"] };
const send = (svc: AlumniService, year?: number) =>
  svc.broadcast(office, { title: "Reunion", body: "Come back", year });

describe("what a broadcast reports", () => {
  it("says how many it reached AND how many it could not", async () => {
    const { svc } = makeService({ linked: 3, unlinked: 47 });
    await expect(send(svc)).resolves.toEqual({ queued: 3, unreachable: 47 });
  });

  it("reports zero unreachable when every alumnus has an account", async () => {
    const { svc } = makeService({ linked: 12, unlinked: 0 });
    await expect(send(svc)).resolves.toEqual({ queued: 12, unreachable: 0 });
  });

  it("counts the unreachable within the SAME audience", async () => {
    // A broadcast to the class of 2019 must not report the whole register's
    // accountless alumni as its own shortfall.
    const { svc, count } = makeService({ linked: 2, unlinked: 5 });
    await send(svc, 2019);
    const wheres = count.mock.calls.map((c) => (c[0] as { where: Record<string, unknown> }).where);
    expect(wheres).toEqual([
      { graduationYear: 2019, userId: { not: null } },
      { graduationYear: 2019, userId: null },
    ]);
  });

  it("still queues nothing when nobody has an account", async () => {
    // And says so, rather than reporting a queued broadcast that reaches
    // nobody at all.
    const { svc, add } = makeService({ linked: 0, unlinked: 9 });
    await expect(send(svc)).resolves.toEqual({ queued: 0, unreachable: 9 });
    expect(add).not.toHaveBeenCalled();
  });

  it("records the shortfall in the audit entry too", async () => {
    // The screen is read once; the audit row is what answers "why did the class
    // of 2015 never hear from us" a year later.
    const { svc } = makeService({ linked: 3, unlinked: 47 });
    const log = (svc as unknown as { log: jest.Mock }).log;
    await send(svc);
    expect(log.mock.calls[0][4]).toMatchObject({ count: 3, unreachable: 47 });
  });
});
