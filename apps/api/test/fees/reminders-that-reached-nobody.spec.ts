// =============================================================================
// "30 reminded", and not one family was told
// =============================================================================
// `sendFeeReminders` incremented `reminded` once per INVOICE, whether or not
// anybody heard. An invoice for a pupil with no guardian linked counted exactly
// like one that reached a parent — so the number a school reads to decide
// whether its families have been chased for money was a count of the loop.
//
// Found by a CROSS-MODULE audit rather than by either module's own tests, which
// is the point: fees counts its own iteration and notifications decides whether
// anyone hears, and neither is wrong on its own.
//
// Measured on a fleet of 5,000 schools aged three years: one school with 30
// billable invoices and 0 guardian links reported
//
//     { reminded: 30, invoices: 30 }
//
// while `notification` held ZERO FEE_REMINDER rows — ever. Fleet-wide, 5,000 of
// 5,000 schools with billable invoices would have reported a full count of
// reminders and reached nobody at all.
//
// `unreachable` is the fourth fact this repo already uses elsewhere: the alumni
// broadcast reports it for records with no linked account. It is not `failed`
// (nothing went wrong), not `skipped` (the invoice was due) — it is work with
// nobody to deliver it to, and naming it is what lets a school fix it by linking
// a guardian.
// =============================================================================

import { FeesService } from "../../src/fees/fees.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const bursar: Principal = {
  schoolId: "A",
  userId: "bursar",
  roles: ["school_admin"],
  permissions: ["fee.manage", "fee.read"],
};

type Inv = {
  id: string; studentId: string; reference: string; totalMinor: number;
  dueDate: Date; currency: string; lastRemindedAt: Date | null;
};

const overdue = (n: number): Inv[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `inv-${i}`,
    studentId: `stu-${i}`,
    reference: `REF-${i}`,
    totalMinor: 15_000_00,
    // Staggered, so a double that ignores `orderBy` cannot be mistaken for one
    // that honours it: every invoice has a distinct due date.
    dueDate: new Date(Date.now() - (30 + n - i) * 86_400_000),
    currency: "NGN",
    lastRemindedAt: null,
  }));


/** Prisma's ordering, as the service asks for it: a list of one-key clauses,
 *  each either `"asc"` or `{ sort, nulls }`. Modelled rather than assumed —
 *  NULLS FIRST is the whole point of the ordering under test, and a comparator
 *  that put nulls last would pass every other case in this file. */
function compareBy(orderBy: unknown) {
  const clauses = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, unknown>>;
  return (a: Inv, b: Inv) => {
    for (const clause of clauses) {
      const [key, spec] = Object.entries(clause)[0] as [keyof Inv, unknown];
      const nullsFirst = typeof spec === "object" && spec !== null && (spec as { nulls?: string }).nulls === "first";
      const av = a[key] ?? null;
      const bv = b[key] ?? null;
      if (av === null && bv === null) continue;
      if (av === null) return nullsFirst ? -1 : 1;
      if (bv === null) return nullsFirst ? 1 : -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return cmp;
    }
    return 0;
  };
}

/** @param linkedFor studentIds that actually have a guardian on file. */
function makeService(invoices: Inv[], linkedFor: string[] = []) {
  const enqueued: Array<{ recipients: string[]; type: string }> = [];
  const tx = {
    invoice: {
      // HONOURS `orderBy` AND `take`. The previous double returned the whole
      // fixture whatever was asked for, which is why nothing here could see
      // that a capped sweep chased the same page every week for ever: with no
      // cap, one run always cleared everything.
      findMany: jest.fn(async ({ orderBy, take }: { orderBy?: unknown; take?: number }) => {
        const ordered = [...invoices].sort(compareBy(orderBy));
        return typeof take === "number" ? ordered.slice(0, take) : ordered;
      }),
      // The sweep counts what is DUE before taking its page, so `backlog` is
      // work left behind the cap rather than an estimate. A double missing
      // `count` fails as a code fault; one answering a fixed number would vouch
      // for a backlog drawn from a different predicate than the page.
      count: jest.fn(async () => invoices.length),
      // Where the sweep records that it chased somebody — the only write it
      // makes to an invoice, and the thing that makes the next run advance.
      updateMany: jest.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: { lastRemindedAt: Date } }) => {
        const ids = new Set(where.id.in);
        for (const inv of invoices) if (ids.has(inv.id)) inv.lastRemindedAt = data.lastRemindedAt;
        return { count: ids.size };
      }),
    },
    payment: { findMany: jest.fn(async () => []) },
    parentChild: {
      findMany: jest.fn(async () => linkedFor.map((studentId) => ({ studentId, parentId: `parent-of-${studentId}` }))),
    },
    school: { findFirst: jest.fn(async () => ({ id: "A", currency: "NGN", timezone: "Africa/Lagos" })) },
  } as unknown as TenantTx;

  const svc = new FeesService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    {
      // The double records WHO would be told, so "reminded" can be checked
      // against deliveries rather than against the service's own counter.
      enqueueMany: jest.fn(async (_c: unknown, recipients: string[], msg: { type: string }) => {
        enqueued.push({ recipients, type: msg.type });
      }),
      enqueue: jest.fn(),
      notify: jest.fn(),
    } as never,
    { isConfigured: () => false } as never,
    { forSchool: jest.fn(async () => ({ currency: "NGN", timezone: "Africa/Lagos" })), todayInTx: async () => new Date() } as never,
  );
  return { svc, enqueued };
}

describe("the fee reminder sweep", () => {
  it("counts the FAMILIES TOLD, not the invoices it walked", async () => {
    // 10 overdue invoices, 3 pupils with a guardian on file.
    const { svc, enqueued } = makeService(overdue(10), ["stu-0", "stu-1", "stu-2"]);
    const r = await svc.sendFeeReminders(bursar, { overdueOnly: true });
    expect(r.invoices).toBe(10);
    expect(r.reminded).toBe(3);
    // And the count matches what actually went out.
    expect(enqueued).toHaveLength(3);
  });

  it("NAMES the ones it could not reach", async () => {
    const { svc } = makeService(overdue(10), ["stu-0", "stu-1", "stu-2"]);
    const r = await svc.sendFeeReminders(bursar, { overdueOnly: true });
    expect(r.unreachable).toBe(7);
    // The three facts add up, so a reader can trust the shortfall.
    expect(r.reminded + r.unreachable).toBe(r.invoices);
  });

  it("reports NOBODY reminded when no pupil has a guardian — the measured case", async () => {
    // A school with 30 billable invoices and no guardian links reported
    // "reminded: 30" and produced zero notifications.
    const { svc, enqueued } = makeService(overdue(30), []);
    const r = await svc.sendFeeReminders(bursar, { overdueOnly: true });
    expect(r).toMatchObject({ invoices: 30, reminded: 0, unreachable: 30 });
    expect(enqueued).toHaveLength(0);
  });

  it("says nothing was unreachable when every family is on file", async () => {
    const { svc } = makeService(overdue(4), ["stu-0", "stu-1", "stu-2", "stu-3"]);
    const r = await svc.sendFeeReminders(bursar, { overdueOnly: true });
    expect(r).toMatchObject({ invoices: 4, reminded: 4, unreachable: 0 });
  });

  it("does not enqueue an empty recipient list", async () => {
    // The old code called the notifier for every invoice, guardians or not —
    // work done for nobody, and the reason the counter looked healthy.
    const { svc, enqueued } = makeService(overdue(5), ["stu-1"]);
    await svc.sendFeeReminders(bursar, { overdueOnly: true });
    expect(enqueued.every((e) => e.recipients.length > 0)).toBe(true);
  });
});

describe("a sweep whose predicate it never changes", () => {
  // THE DEFECT. An unpaid invoice does not leave this sweep's predicate — the
  // sweep sends a notification, it does not touch the invoice — so a capped
  // page ordered by DUE DATE took the identical rows every week. Measured live
  // on 2,100 overdue invoices against a cap of 2,000: two full runs sent 2,000
  // reminders each about the SAME 2,000 invoices, and the 100 NEWEST arrears —
  // the most collectable end of the book — were never chased once. `backlog`
  // read 105 on both runs, which says "behind", not "stuck".
  //
  // Ordering by what the sweep DOES change rotates the book instead.
  const CAP = 2000;

  it("reaches, over two runs, everybody a single capped run left out", async () => {
    const invoices = overdue(CAP + 100);
    const students = invoices.map((i) => i.studentId);
    const { svc, enqueued } = makeService(invoices, students);

    await svc.sendFeeReminders(bursar, { overdueOnly: true });
    const first = new Set(enqueued.flatMap((e) => e.recipients));
    await svc.sendFeeReminders(bursar, { overdueOnly: true });
    const everybody = new Set(enqueued.flatMap((e) => e.recipients));

    expect(first.size).toBe(CAP);
    expect(everybody.size).toBe(CAP + 100);
    // Nothing is left never-chased. Under the old ordering this was 100.
    expect(invoices.filter((i) => i.lastRemindedAt === null)).toHaveLength(0);
  });

  it("puts the never-chased ahead of the recently-chased", async () => {
    // Which is what makes the rotation a rotation rather than a reshuffle.
    // `overdue()` makes inv-0 the OLDEST debt, so the two already chased here
    // are exactly the two due-date ordering would take first — which is what
    // starved the rest, week after week.
    const invoices = overdue(4);
    invoices[0].lastRemindedAt = new Date(Date.now() - 86_400_000);
    invoices[1].lastRemindedAt = new Date(Date.now() - 2 * 86_400_000);
    const { svc, enqueued } = makeService(invoices, invoices.map((i) => i.studentId));

    await svc.sendFeeReminders(bursar, { overdueOnly: true });
    const orderTold = enqueued.flatMap((e) => e.recipients);
    // The two nobody has chased come first; then the least recently chased.
    expect(orderTold).toEqual([
      "parent-of-stu-2", "parent-of-stu-3", "parent-of-stu-1", "parent-of-stu-0",
    ]);
  });

  it("does not stamp an invoice nobody could be told about", async () => {
    // An `unreachable` invoice has not been chased. Stamping it would push a
    // pupil with no guardian to the back of the rotation for ever, and hide the
    // very gap `unreachable` exists to report.
    const invoices = overdue(3);
    const { svc } = makeService(invoices, ["stu-0"]);
    await svc.sendFeeReminders(bursar, { overdueOnly: true });
    expect(invoices.find((i) => i.studentId === "stu-0")!.lastRemindedAt).toBeInstanceOf(Date);
    expect(invoices.filter((i) => i.lastRemindedAt === null)).toHaveLength(2);
  });
});
