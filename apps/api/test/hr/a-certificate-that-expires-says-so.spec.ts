// =============================================================================
// A certificate that has EXPIRED says so — and says it once
// =============================================================================
// The sweep announced a document once, up to 30 days before expiry, stamped
// `reminderSentAt` and never looked again. Measured live: an already-lapsed
// licence was announced in the FUTURE TENSE ("expires on 2026-08-23", five days
// after it had), and a second run returned {"reminded":0} — so the document
// expiring in ten days would never be mentioned when it actually did.
//
// Both halves are pinned, and the pure rules are tested SEPARATELY from the
// service that drives them: a test on a helper proves nothing about its caller,
// the seam that hid the CBT score and the report-card promotion line.
// =============================================================================

import {
  DOCUMENT_REMINDER_WINDOW_DAYS,
  documentExpiryNotice,
  expiryStage,
  expiryCandidateWhere,
} from "../../src/hr/document-expiry";
import { StaffLifecycleService } from "../../src/hr/staff-lifecycle.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const TODAY = new Date("2026-08-28T00:00:00.000Z");
const day = (n: number) => new Date(TODAY.getTime() + n * 86_400_000);

describe("which notice a document is owed", () => {
  it("is EXPIRED once the day it names has passed", () => {
    expect(expiryStage(day(-1), TODAY)).toBe("EXPIRED");
    expect(expiryStage(day(-400), TODAY)).toBe("EXPIRED");
  });

  it("is still valid ON the day it names — a certificate lasts through that day", () => {
    // The boundary a `<=` would get wrong, and it is the direction that matters:
    // telling a school a licence has expired while it is still valid is a
    // false statement about somebody's right to do their job.
    expect(expiryStage(TODAY, TODAY)).toBe("EXPIRING");
  });

  it("is EXPIRING inside the window and nothing at all outside it", () => {
    expect(expiryStage(day(DOCUMENT_REMINDER_WINDOW_DAYS), TODAY)).toBe("EXPIRING");
    expect(expiryStage(day(DOCUMENT_REMINDER_WINDOW_DAYS + 1), TODAY)).toBeNull();
  });

  it("says nothing about a document with no expiry date", () => {
    expect(expiryStage(null, TODAY)).toBeNull();
  });

  it("does not warn about something that has already happened", () => {
    // An already-lapsed document seen for the FIRST time goes straight to
    // EXPIRED. This is the live defect: the old window admitted it and the old
    // wording announced it in the future tense.
    expect(expiryStage(day(-5), TODAY)).toBe("EXPIRED");
    const notice = documentExpiryNotice(
      { who: "Demo HR Clerk", kind: "TEACHING_LICENCE", name: "Licence", expiresAt: day(-5) },
      "EXPIRED",
    );
    expect(notice.title).toMatch(/EXPIRED/);
    expect(notice.body).toContain("expired on 2026-08-23");
    expect(notice.body).not.toContain("expires on");
  });

  it("the approaching notice keeps the future tense", () => {
    const notice = documentExpiryNotice(
      { who: "Demo Teacher", kind: "SAFEGUARDING", name: "DBS", expiresAt: day(10) },
      "EXPIRING",
    );
    expect(notice.body).toContain("expires on 2026-09-07");
    expect(notice.title).not.toMatch(/EXPIRED/);
  });
});

describe("the candidate query", () => {
  it("excludes rows already at the terminal stage", () => {
    // Without this every document a school has ever let lapse is re-read every
    // night for ever, to be skipped — the O(the school's lifetime) shape.
    const where = expiryCandidateWhere(TODAY) as {
      OR: Array<Record<string, unknown>>;
      expiresAt: { lte: Date };
    };
    expect(where.OR).toEqual([{ expiryNoticeStage: null }, { expiryNoticeStage: { not: "EXPIRED" } }]);
  });

  it("leaves slack for a school whose day is ahead of the server's", () => {
    // The fleet sweep runs before any school's own day is known. A ceiling of
    // exactly 30 days would drop a document from the candidate set before the
    // school it belongs to had been asked.
    const where = expiryCandidateWhere(TODAY) as { expiresAt: { lte: Date } };
    expect(where.expiresAt.lte.getTime()).toBeGreaterThan(day(DOCUMENT_REMINDER_WINDOW_DAYS).getTime());
  });
});

// --- and the service that drives them ---------------------------------------

function make(docs: Array<Record<string, unknown>>) {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const docUpdate = jest.fn().mockResolvedValue({});
  const tx = {
    user: { findMany: jest.fn().mockResolvedValue([{ id: "u1", name: "Ada" }]) },
    staffDocument: { findMany: jest.fn().mockResolvedValue(docs), update: docUpdate },
    role: { findMany: jest.fn().mockResolvedValue([{ id: "r1" }]) },
    userRole: { findMany: jest.fn().mockResolvedValue([{ userId: "hr1" }]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const region = { todayInTx: jest.fn(async () => TODAY) };
  return {
    service: new StaffLifecycleService(db as never, audit as never, { enqueue } as never, region as never),
    enqueue,
    docUpdate,
    region,
  };
}

const p: Principal = { schoolId: "A", userId: "hr1", roles: [], permissions: [] };
const doc = (over: Record<string, unknown>) => ({
  id: "d1", userId: "u1", kind: "TEACHING_LICENCE", name: "Licence",
  expiresAt: day(-5), expiryNoticeStage: null, ...over,
});

describe("runDocumentReminders", () => {
  it("announces a lapse the school was never told about", async () => {
    // The live defect end to end: a document that already had its "expiring"
    // notice, and has since expired, was silent for ever.
    const { service, enqueue, docUpdate } = make([doc({ expiryNoticeStage: "EXPIRING" })]);
    const res = await service.runDocumentReminders(p);
    expect(res.reminded).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Staff document has EXPIRED" }),
    );
    expect(docUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expiryNoticeStage: "EXPIRED" }) }),
    );
  });

  it("says it ONCE — the same stage is never announced twice", async () => {
    const { service, enqueue } = make([doc({ expiryNoticeStage: "EXPIRED" })]);
    expect((await service.runDocumentReminders(p)).reminded).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not re-announce a document still merely approaching", async () => {
    const { service, enqueue } = make([doc({ expiresAt: day(10), expiryNoticeStage: "EXPIRING" })]);
    expect((await service.runDocumentReminders(p)).reminded).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("asks the SCHOOL's day, not the server's", async () => {
    // Resolved AND compared: a version that resolves the school's day and then
    // filters on `new Date()` anyway would pass a test that only checked the
    // lookup happened — the trap the country fix records.
    const { service, region, enqueue } = make([doc({ expiresAt: day(10), expiryNoticeStage: "EXPIRING" })]);
    region.todayInTx.mockResolvedValue(day(20)); // the school is well past it
    expect((await service.runDocumentReminders(p)).reminded).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Staff document has EXPIRED" }),
    );
  });
});

// --- the FLEET sweep, which is the other half of the pair that drifted -------
// The manual endpoint and the nightly job are two implementations of one rule,
// and the nightly one had no test of this arm at all. A test on the pure
// helpers proves nothing about either caller.

import { StaffReminderService } from "../../src/hr/staff-reminder.service";

function makeSweep(docs: Array<Record<string, unknown>>, contracts: Array<Record<string, unknown>> = []) {
  const docUpdate = jest.fn().mockResolvedValue({});
  const employeeUpdate = jest.fn().mockResolvedValue({});
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const client = {
    staffExit: { findMany: jest.fn().mockResolvedValue([]) },
    user: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), findMany: jest.fn().mockResolvedValue([{ id: "u1", name: "Ada" }]) },
    salaryChangeRequest: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    employee: { update: employeeUpdate, findMany: jest.fn().mockResolvedValue(contracts) },
    employmentChangeRequest: { findMany: jest.fn().mockResolvedValue([]) },
    userRole: { findMany: jest.fn().mockResolvedValue([{ userId: "hr1" }]) },
    staffDocument: { findMany: jest.fn().mockResolvedValue(docs), update: docUpdate },
  };
  const svc = new StaffReminderService(
    { client } as never,
    { enqueue, enqueueMany: jest.fn().mockResolvedValue({ created: 0, failed: 0 }), notifyPermissionHolders: jest.fn().mockResolvedValue(0) } as never,
    { forSchool: jest.fn().mockResolvedValue({ timezone: "UTC" }) } as never,
  );
  return { svc, docUpdate, enqueue, employeeUpdate };
}

const fleetDoc = (over: Record<string, unknown>) => ({
  id: "d1", schoolId: "A", userId: "u1", kind: "SAFEGUARDING", name: "DBS",
  expiresAt: new Date(Date.now() - 5 * 86_400_000), expiryNoticeStage: "EXPIRING", ...over,
});

describe("the nightly fleet sweep", () => {
  it("announces a lapse, and stamps the terminal stage", async () => {
    const { svc, enqueue, docUpdate } = makeSweep([fleetDoc({})]);
    const res = await svc.sweep();
    expect(enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Staff document has EXPIRED" }),
    );
    expect(docUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expiryNoticeStage: "EXPIRED" }) }),
    );
    expect(res.reminded).toBe(1);
  });

  it("REPORTS WHAT IT DID, not what it looked at", async () => {
    // The candidate set is a superset: a row whose stage has not changed is
    // scanned and deliberately not announced. Reporting `scanned` as `reminded`
    // is the count-nobody-can-act-on shape — an operator reading "3 reminded"
    // for a night that sent nothing.
    const { svc, enqueue } = makeSweep([
      fleetDoc({ id: "a", expiryNoticeStage: "EXPIRED" }),
      fleetDoc({ id: "b", expiresAt: new Date(Date.now() + 10 * 86_400_000), expiryNoticeStage: "EXPIRING" }),
      fleetDoc({ id: "c" }),
    ]);
    const res = await svc.sweep();
    expect(res.scanned).toBe(3);
    expect(res.reminded).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("the contract sibling, in the same file one method down", () => {
  const contract = (over: Record<string, unknown>) => ({
    id: "e1", schoolId: "A", userId: "u1",
    endDate: new Date(Date.now() - 3 * 86_400_000), contractNoticeStage: "EXPIRING", ...over,
  });

  it("says a contract has ENDED while the employee is still active", async () => {
    const { svc, enqueue, employeeUpdate } = makeSweep([], [contract({})]);
    await svc.sweep();
    expect(enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Contract has ENDED" }),
    );
    expect(employeeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contractNoticeStage: "EXPIRED" }) }),
    );
  });

  it("keeps the future tense while it is still ahead, and says it once", async () => {
    const ahead = contract({ endDate: new Date(Date.now() + 10 * 86_400_000), contractNoticeStage: null });
    const { svc, enqueue } = makeSweep([], [ahead]);
    await svc.sweep();
    expect(enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "Contract ending soon" }));

    const { svc: s2, enqueue: e2 } = makeSweep([], [{ ...ahead, contractNoticeStage: "EXPIRING" }]);
    await s2.sweep();
    expect(e2).not.toHaveBeenCalled();
  });
});

describe("the arms are independent", () => {
  it("looks at contracts on a night when no DOCUMENT is due", async () => {
    // Pre-existing, and my contract test is what surfaced it: `sweepContracts`
    // is called at the END of sweep(), behind an early return in the document
    // arm. `staff_document` was empty across the whole demo tenant, so the
    // contract arm had never run once. The two arms above it each carry a
    // comment saying why they must be independent; the third was not.
    const { svc, enqueue } = makeSweep([], [
      { id: "e1", schoolId: "A", userId: "u1", endDate: new Date(Date.now() - 3 * 86_400_000), contractNoticeStage: "EXPIRING" },
    ]);
    await svc.sweep();
    expect(enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "Contract has ENDED" }));
  });
});
