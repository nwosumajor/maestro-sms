/**
 * The weekly overdue-fee sweep — the message that asks families for money —
 * opened a tenant transaction PER INVOICE just to find out who to write to, and
 * another PER GUARDIAN to write it. Measured live: 91 bills, 2,642 ms. A school
 * with 900 overdue bills is 2,700 transactions and about half a minute, on a job
 * that runs for every school on the platform.
 *
 * The rules are unchanged — same recipients, same wording, same best-effort
 * isolation. What is pinned here is that the WORK does not grow one-per-person.
 */
import { FeesService } from "../../src/fees/fees.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const p: Principal = { schoolId: "S", userId: "u1", roles: ["accountant"], permissions: ["fee.manage"] };

function makeService(bills: number, guardiansPer = 2) {
  const calls: string[] = [];
  const invoices = Array.from({ length: bills }, (_, i) => ({
    id: `inv${i}`, reference: `INV-${i}`, studentId: `stu${i}`, currency: "NGN",
    totalMinor: 100000, dueDate: new Date(Date.now() - 864e5 * 30), status: "ISSUED",
    payments: [], lineItems: [],
  }));
  const links = invoices.flatMap((inv) =>
    Array.from({ length: guardiansPer }, (_, g) => ({ studentId: inv.studentId, parentId: `${inv.studentId}-p${g}` })));
  const tx = {
    invoice: { findMany: jest.fn(() => { calls.push("invoice.findMany"); return Promise.resolve(invoices); }) },
    payment: { findMany: jest.fn(() => { calls.push("payment.findMany"); return Promise.resolve([]); }) },
    parentChild: {
      findMany: jest.fn((a: { where: { studentId: unknown } }) => {
        const w = a.where.studentId as { in?: string[] } | string;
        calls.push(typeof w === "object" && w?.in ? "parentChild.findMany(batch)" : "parentChild.findMany(one)");
        if (typeof w === "object" && w?.in) return Promise.resolve(links.filter((l) => w.in!.includes(l.studentId)));
        return Promise.resolve(links.filter((l) => l.studentId === w));
      }),
    },
    school: { findFirst: jest.fn(() => Promise.resolve({ currency: "NGN" })) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => { calls.push("tx"); return fn(tx); },
    runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => { calls.push("tx"); return fn(tx); },
  };
  const enqueue = jest.fn(() => { calls.push("enqueue"); return Promise.resolve(undefined); });
  const enqueueMany = jest.fn((_a: unknown, to: string[]) => { calls.push("enqueueMany"); return Promise.resolve({ created: to.length, failed: 0 }); });
  const service = new FeesService(db as never, { record: jest.fn() } as never,
    { enqueue, enqueueMany } as never, {} as never,
    { todayInTx: async () => new Date() } as never);
  return { service, calls, enqueue, enqueueMany };
}

describe("the overdue-fee sweep", () => {
  it("looks every family up in ONE query, not one per bill", async () => {
    const { service, calls } = makeService(50);
    await service.sendFeeReminders(p, { overdueOnly: true });
    expect(calls.filter((c) => c === "parentChild.findMany(batch)")).toHaveLength(1);
    expect(calls.filter((c) => c === "parentChild.findMany(one)")).toHaveLength(0);
  });

  it("writes ONE notification per family, not one per guardian", async () => {
    const { service, calls, enqueueMany } = makeService(50, 3);
    await service.sendFeeReminders(p, { overdueOnly: true });
    expect(calls.filter((c) => c === "enqueue")).toHaveLength(0);
    expect(enqueueMany).toHaveBeenCalledTimes(50);
    for (const c of enqueueMany.mock.calls) expect(c[1] as string[]).toHaveLength(3);
  });

  it("opens far fewer transactions than it has recipients", async () => {
    const { service, calls } = makeService(50, 3);   // 150 recipients
    await service.sendFeeReminders(p, { overdueOnly: true });
    expect(calls.filter((c) => c === "tx").length).toBeLessThan(10);
  });

  // The half that must not be traded away.
  it("still reaches every guardian of every reminded bill, and nobody else", async () => {
    const { service, enqueueMany } = makeService(3, 2);
    const res = await service.sendFeeReminders(p, { overdueOnly: true });
    expect(res).toMatchObject({ reminded: 3, invoices: 3 });
    const to = enqueueMany.mock.calls.flatMap((c) => c[1] as string[]).sort();
    expect(to).toEqual(["stu0-p0", "stu0-p1", "stu1-p0", "stu1-p1", "stu2-p0", "stu2-p1"]);
  });

  it("a pupil with no guardian on file is skipped, not sent into the void", async () => {
    const { service, enqueueMany } = makeService(2, 0);
    await service.sendFeeReminders(p, { overdueOnly: true });
    for (const c of enqueueMany.mock.calls) expect(c[1] as string[]).toHaveLength(0);
  });
});
