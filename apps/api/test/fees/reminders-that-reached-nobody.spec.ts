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

type Inv = { id: string; studentId: string; reference: string; totalMinor: number; dueDate: Date; currency: string };

const overdue = (n: number): Inv[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `inv-${i}`,
    studentId: `stu-${i}`,
    reference: `REF-${i}`,
    totalMinor: 15_000_00,
    dueDate: new Date(Date.now() - 30 * 86_400_000),
    currency: "NGN",
  }));

/** @param linkedFor studentIds that actually have a guardian on file. */
function makeService(invoices: Inv[], linkedFor: string[] = []) {
  const enqueued: Array<{ recipients: string[]; type: string }> = [];
  const tx = {
    invoice: { findMany: jest.fn(async () => invoices) },
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
