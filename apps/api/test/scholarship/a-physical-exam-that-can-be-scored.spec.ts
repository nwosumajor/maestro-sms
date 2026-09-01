/**
 * A PHYSICAL scholarship exam could be chosen, its candidates were told the
 * venue and the time — and there was NO WAY to record what they scored.
 * `writeScores` was private with two callers (CBT sittings and the arena) and
 * no route accepted a mark, so a paper exam ran to the end of its process and
 * dead-ended: nobody could be scored, so nobody could be ranked, so no school
 * could win its prize on merit. The mode was offered and could not be finished.
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ScholarshipAdminService } from "../../src/scholarship/scholarship-admin.service";

const PROGRAM = "11111111-1111-1111-1111-111111111111";
const A1 = "aaaaaaaa-1111-1111-1111-111111111111";
const A2 = "aaaaaaaa-2222-2222-2222-222222222222";
const STRANGER = "bbbbbbbb-3333-3333-3333-333333333333";

function svc(examMode: string, qualified: string[]) {
  const writes: Array<Array<{ id: string; pct: number }>> = [];
  const audits: Array<{ action: string; meta: unknown }> = [];
  const client = {
    scholarshipProgram: { findFirst: async () => ({ id: PROGRAM, examMode }) },
    scholarshipApplication: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => qualified.includes(id)).map((id) => ({ id })),
    },
    // The real writeScores runs one raw UPDATE ... FROM (VALUES ...).
    $executeRaw: async () => 0,
  };
  const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
  Object.assign(s, {
    client: () => client,
    auditOwn: async (_p: unknown, action: string, _id: string, meta: unknown) => {
      audits.push({ action, meta });
    },
    writeScores: async (_db: unknown, scored: Array<{ id: string; pct: number }>) => {
      writes.push(scored);
      return scored.length;
    },
  });
  return { s, writes, audits };
}

const P = { userId: "op", schoolId: "plat", roles: ["super_admin"], permissions: [] } as never;

describe("a physical scholarship exam can be scored", () => {
  it("records a mark for each qualified candidate", async () => {
    const { s, writes } = svc("PHYSICAL", [A1, A2]);
    const out = await s.recordPhysicalScores(P, PROGRAM, [
      { applicationId: A1, scorePct: 82.5 },
      { applicationId: A2, scorePct: 61 },
    ]);
    expect(out.updated).toBe(2);
    expect(writes[0]).toEqual([
      { id: A1, pct: 82.5 },
      { id: A2, pct: 61 },
    ]);
  });

  it("audits the entry", async () => {
    const { s, audits } = svc("PHYSICAL", [A1]);
    await s.recordPhysicalScores(P, PROGRAM, [{ applicationId: A1, scorePct: 50 }]);
    expect(audits.map((a) => a.action)).toContain("scholarship.exam.score");
  });

  // PHYSICAL ONLY. A CBT programme's scores come from the sittings, so a
  // hand-typed mark there is either overwritten by the next collect or silently
  // overwrites a real script — two writers of one column disagreeing.
  it.each(["ONLINE_CBT", "GAMES"])("refuses a %s programme rather than creating a second writer", async (mode) => {
    const { s, writes } = svc(mode, [A1]);
    await expect(s.recordPhysicalScores(P, PROGRAM, [{ applicationId: A1, scorePct: 50 }])).rejects.toThrow(
      BadRequestException,
    );
    expect(writes).toHaveLength(0);
  });

  // The whole list, never the recognised part: a mark sheet silently one name
  // short is the silent-partial-success shape, and the operator would believe
  // every candidate in front of them was recorded.
  it("refuses the WHOLE sheet when one id is not a candidate of this programme", async () => {
    const { s, writes } = svc("PHYSICAL", [A1, A2]);
    await expect(
      s.recordPhysicalScores(P, PROGRAM, [
        { applicationId: A1, scorePct: 70 },
        { applicationId: STRANGER, scorePct: 99 },
      ]),
    ).rejects.toThrow(/not qualified candidates/);
    expect(writes).toHaveLength(0);
  });

  it("404s a programme that does not exist", async () => {
    const { s } = svc("PHYSICAL", []);
    Object.assign(s, { client: () => ({ scholarshipProgram: { findFirst: async () => null } }) });
    await expect(s.recordPhysicalScores(P, "nope", [{ applicationId: A1, scorePct: 1 }])).rejects.toThrow(
      NotFoundException,
    );
  });
});

/**
 * An award is TWO awards — a fees credit to the pupil and a free window of
 * ENTERPRISE to their school — and only one of them could be taken back. So a
 * mistaken or fraudulent award was reversed for the family while the school
 * kept up to nine months of a paid tier, on no screen and with no way back,
 * and the operator was told the award had been reversed.
 */
describe("taking an award back takes the school's half back too", () => {
  const MONTHS = { 1: 9, 2: 6, 3: 3 } as const;

  function prizeSvc(grantedUntil: Date | null) {
    const updates: Array<Record<string, unknown>> = [];
    const notices: Array<{ title: string; body: string }> = [];
    const db = {
      schoolSubscription: {
        findFirst: async () => (grantedUntil === undefined ? null : { id: "sub1", grantedUntil }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return {};
        },
      },
    };
    const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
    Object.assign(s, {
      logger: { error: () => undefined },
      modules: { invalidate: () => undefined },
      notifySchool: async (_id: string, title: string, body: string) => {
        notices.push({ title, body });
      },
    });
    return { s, db, updates, notices };
  }

  const revoke = (s: ScholarshipAdminService, db: unknown, position: number) =>
    (s as unknown as {
      revokeSchoolPrize: (db: unknown, schoolId: string, position: number, title: string, actorId: string) => Promise<void>;
    }).revokeSchoolPrize(db, "school1", position, "PROBE", "op");

  // SUBTRACT THE MONTHS, never clear the window: the grant EXTENDS rather than
  // replaces, so nulling the columns would destroy a second, legitimate prize.
  it("shortens a stacked window by exactly the months this award added", async () => {
    // Two prizes stacked: a 1st (9 months) on top of a 3rd (3 months).
    const until = new Date("2028-01-01T00:00:00.000Z");
    const { s, db, updates } = prizeSvc(until);
    await revoke(s, db, 1);
    const next = updates[0].grantedUntil as Date;
    const expected = new Date(until);
    expected.setMonth(expected.getMonth() - MONTHS[1]);
    expect(next.toISOString()).toBe(expected.toISOString());
    // The other prize survives — the columns are NOT cleared.
    expect(updates[0].grantedPlan).toBeUndefined();
  });

  it("ends the grant outright when nothing is left of it", async () => {
    const soon = new Date(Date.now() + 5 * 24 * 3600 * 1000);
    const { s, db, updates, notices } = prizeSvc(soon);
    await revoke(s, db, 1);
    expect(updates[0]).toMatchObject({ grantedPlan: null, grantedUntil: null, grantedReason: null });
    expect(notices[0].title).toMatch(/has ended/);
  });

  it("tells the school, and says their own bill is unchanged", async () => {
    const { s, db, notices } = prizeSvc(new Date("2028-01-01T00:00:00.000Z"));
    await revoke(s, db, 1);
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toMatch(/what you pay for it are unchanged/);
  });

  it("does nothing when the school never held a grant", async () => {
    const { s, db, updates } = prizeSvc(null);
    await revoke(s, db, 1);
    expect(updates).toHaveLength(0);
  });

  // A best-effort reversal must never unwind the revocation itself: the pupil's
  // money has already been returned and the application is already QUALIFIED.
  it("swallows a failure rather than undoing the revocation", async () => {
    const { s } = prizeSvc(new Date("2028-01-01T00:00:00.000Z"));
    const broken = { schoolSubscription: { findFirst: async () => { throw new Error("db down"); } } };
    await expect(revoke(s, broken, 1)).resolves.toBeUndefined();
  });
});

/**
 * A test on the helper proves nothing about its caller — the seam that hid the
 * CBT score and the report-card promotion line. Mutation testing showed the
 * eight tests above all passing with `revokeAward` never calling it at all.
 */
describe("revokeAward reverses BOTH halves", () => {
  function revokeSvc(awardPosition: number | null) {
    const reversed: Array<{ schoolId: string; position: number }> = [];
    const app = {
      id: "app1",
      programId: "prog1",
      schoolId: "school1",
      studentId: "stu1",
      status: "AWARDED",
      awardPosition,
      disbursementPaymentId: null,
      disbursementCreditEntryId: null,
    };
    const db = {
      scholarshipApplication: {
        findFirst: async () => app,
        updateMany: async () => ({ count: 1 }),
        // The real revoke re-reads the row to build its DTO reply.
        findMany: async () => [app],
      },
      school: { findMany: async () => [] },
      user: { findMany: async () => [] },
      scholarshipProgram: { findFirst: async () => ({ title: "PROBE" }) },
    };
    const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
    Object.assign(s, {
      client: () => db,
      logger: { error: () => undefined },
      auditOwn: async () => undefined,
      notifyFamily: async () => undefined,
      listApplicationById: async () => [{ id: "app1" }],
      revokeSchoolPrize: async (_db: unknown, schoolId: string, position: number) => {
        reversed.push({ schoolId, position });
      },
    });
    return { s, reversed };
  }

  it("takes the school prize back for the position that was awarded", async () => {
    const { s, reversed } = revokeSvc(1);
    await s.revokeAward(P, "app1", "wrong pupil");
    expect(reversed).toEqual([{ schoolId: "school1", position: 1 }]);
  });

  it("reverses the position ACTUALLY awarded, not a fixed one", async () => {
    const { s, reversed } = revokeSvc(3);
    await s.revokeAward(P, "app1", "wrong pupil");
    expect(reversed[0].position).toBe(3);
  });

  it("does nothing to a school whose pupil held no position", async () => {
    const { s, reversed } = revokeSvc(null);
    await s.revokeAward(P, "app1", "wrong pupil");
    expect(reversed).toHaveLength(0);
  });
});

/**
 * A scholarship qualifies a COHORT. Measured on the 5,000-applicant exercise:
 * qualifying 1,000 one row at a time took 15.7 s and the platform's OWN
 * per-tenant limiter (1,200/min, keyed on the caller's school) refused 494 of
 * them with a 429. The same work in one call is 0.41 s.
 */
describe("a cohort can be decided in one call", () => {
  function bulkSvc(rows: Array<{ id: string; status: string }>) {
    const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    const audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
    const db = {
      scholarshipApplication: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          rows.filter((r) => where.id.in.includes(r.id)),
        updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: (args.where as { id: { in: string[] } }).id.in.length };
        },
      },
    };
    const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
    Object.assign(s, {
      client: () => db,
      auditOwn: async (_p: unknown, action: string, _id: string, meta: Record<string, unknown>) => {
        audits.push({ action, meta });
      },
    });
    return { s, updates, audits };
  }

  it("moves every eligible application in ONE statement", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ id: `id${i}`, status: "SUBMITTED" }));
    const { s, updates } = bulkSvc(rows);
    const out = await s.decideBulk(P, rows.map((r) => r.id), "QUALIFY");
    expect(out.updated).toBe(300);
    // One round trip, not 300 — the same reason `writeScores` is a single UPDATE.
    expect(updates).toHaveLength(1);
    expect(updates[0].data.status).toBe("QUALIFIED");
  });

  // PARTIAL SUCCESS IS REPORTED, and this is deliberately the OPPOSITE call from
  // the physical mark sheet, which refuses whole. A mark sheet is one document
  // where a missing name is invisible; this is a selection an operator made on
  // screen, where "3 of 500 were already rejected" is actionable.
  it("reports what it did NOT do, by reason", async () => {
    const { s, updates } = bulkSvc([
      { id: "ok", status: "SUBMITTED" },
      { id: "done", status: "AWARDED" },
      { id: "early", status: "PENDING_PRINCIPAL" },
    ]);
    const out = await s.decideBulk(P, ["ok", "done", "early", "ghost"], "QUALIFY");
    expect(out.updated).toBe(1);
    expect(out.skipped).toEqual([
      { id: "done", reason: "already finalised" },
      { id: "early", reason: "has not completed its school approval chain" },
      { id: "ghost", reason: "not found" },
    ]);
    // The eligible one still moved — a skipped row must not hold up the rest.
    expect((updates[0].where as { id: { in: string[] } }).id.in).toEqual(["ok"]);
  });

  it("issues no statement at all when nothing is eligible", async () => {
    const { s, updates } = bulkSvc([{ id: "done", status: "REJECTED" }]);
    const out = await s.decideBulk(P, ["done"], "QUALIFY");
    expect(out.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  // ONE audit row for the batch: a row per application would bury the log for
  // exactly the action that most needs to be legible afterwards.
  it("writes one audit row carrying what was and was not done", async () => {
    const { s, audits } = bulkSvc([{ id: "ok", status: "SUBMITTED" }]);
    await s.decideBulk(P, ["ok", "ghost"], "SHORTLIST");
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("scholarship.applications.decide-bulk");
    expect(audits[0].meta).toMatchObject({ action: "SHORTLIST", requested: 2, updated: 1, skipped: 1 });
  });
});
