// =============================================================================
// AcademicService — calendar correctness (session-sync, quick-create, validation)
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { AcademicService } from "../../src/lms/academic.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const p: Principal = { schoolId: "A", userId: "u1", roles: ["principal"], permissions: ["academic.manage"] };

function svc(tx: TenantTx) {
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new AcademicService(db as never, audit as never), audit };
}

describe("AcademicService.setCurrentTerm", () => {
  it("makes the term's SESSION current too (no pointer outside the current session)", async () => {
    const sessionUpdate = jest.fn().mockResolvedValue({});
    const tx = {
      term: {
        // Dated: a term without both dates can no longer BE made current.
        findFirst: jest.fn().mockResolvedValue({ id: "t2", sessionId: "s9", name: "Second Term", startDate: new Date("2027-01-05"), endDate: new Date("2027-04-01") }),
        updateMany: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      academicSession: {
        updateMany: jest.fn().mockResolvedValue({}),
        update: sessionUpdate,
      },
    } as unknown as TenantTx;
    await svc(tx).service.setCurrentTerm(p, "t2");
    // The session pointer is moved to the term's own session.
    expect(sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s9" }, data: { isCurrent: true } }));
  });
});

describe("AcademicService.createStandardSession", () => {
  it("creates the session plus exactly three sequenced terms in one action", async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 3 });
    const tx = {
      school: { findFirst: jest.fn().mockResolvedValue({ calendarTemplate: "THREE_TERM" }) },
      academicSession: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: "s1" }),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: "s1", name: "2025/2026", isCurrent: false, startDate: new Date(), endDate: new Date() }),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      term: {
        createMany,
        findFirst: jest.fn().mockResolvedValue({ id: "t1" }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
    } as unknown as TenantTx;
    await svc(tx).service.createStandardSession(p, { name: "2025/2026", yearStart: "2025-09-08" });
    const rows = (createMany.mock.calls[0][0] as { data: unknown[] }).data;
    expect(rows).toHaveLength(3);
    expect((rows as Array<{ sequence: number }>).map((r) => r.sequence)).toEqual([1, 2, 3]);
  });
});

describe("AcademicService.setCurrentToToday", () => {
  it("400s when no term's dates contain today", async () => {
    const tx = { term: { findFirst: jest.fn().mockResolvedValue(null) } } as unknown as TenantTx;
    await expect(svc(tx).service.setCurrentToToday(p)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("AcademicService.addTerm validation", () => {
  it("rejects a term overlapping a sibling and never writes it", async () => {
    const create = jest.fn();
    const tx = {
      academicSession: { findFirst: jest.fn().mockResolvedValue({ id: "s1", startDate: new Date("2025-09-01"), endDate: new Date("2026-07-31") }) },
      term: {
        findMany: jest.fn().mockResolvedValue([
          { id: "t1", sessionId: "s1", name: "First Term", sequence: 1, startDate: new Date("2025-09-08"), endDate: new Date("2025-12-12") },
        ]),
        create,
      },
    } as unknown as TenantTx;
    await expect(
      svc(tx).service.addTerm(p, "s1", { name: "Second Term", sequence: 2, startDate: "2025-12-01", endDate: "2026-03-01" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("AcademicService.setCurrentTerm refuses a dateless term", () => {
  // Promoted from a warning to a refusal: this is the one state where failing
  // open costs the past-term register lock, so it is blocked at the point the
  // term becomes current rather than reported afterwards.
  const withTerm = (term: Record<string, unknown>) =>
    ({
      term: {
        findFirst: jest.fn().mockResolvedValue(term),
        updateMany: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      academicSession: { updateMany: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    }) as unknown as TenantTx;

  it("refuses when BOTH dates are missing, and says why", async () => {
    const tx = withTerm({ id: "t1", sessionId: "s1", name: "First Term", startDate: null, endDate: null });
    const { service } = svc(tx);
    await expect(service.setCurrentTerm({ schoolId: "s", userId: "u", roles: [], permissions: [] } as never, "t1"))
      .rejects.toThrow(/register lock is off/i);
  });

  it("refuses when only the START date is missing", async () => {
    // The start date is the one the lock reads, so this is the dangerous half.
    const tx = withTerm({ id: "t1", sessionId: "s1", name: "First Term", startDate: null, endDate: new Date("2026-12-15") });
    const { service } = svc(tx);
    await expect(service.setCurrentTerm({ schoolId: "s", userId: "u", roles: [], permissions: [] } as never, "t1"))
      .rejects.toThrow(/needs start date/i);
  });

  it("does NOT write anything when it refuses", async () => {
    // A refusal that had already cleared the previous current term would leave
    // the school with no current term at all — worse than where it started.
    const tx = withTerm({ id: "t1", sessionId: "s1", name: "First Term", startDate: null, endDate: null });
    const { service } = svc(tx);
    await service
      .setCurrentTerm({ schoolId: "s", userId: "u", roles: [], permissions: [] } as never, "t1")
      .catch(() => undefined);
    expect((tx.term.updateMany as jest.Mock)).not.toHaveBeenCalled();
    expect((tx.term.update as jest.Mock)).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Onboarding part-way through a session
// =============================================================================
// A school does not always join in September. When one onboards in February and
// uses the quick-create, the term that is current has to be the term they are
// actually IN — the pointer drives the past-term register lock, which term every
// register and mark files against, and the term named on every report card.
// Getting it wrong is silent in all three places.

describe("AcademicService.createStandardSession — which term becomes current", () => {
  /** Builds a tx whose term.findFirst answers the "contains today" query with
   *  `containing`, and any other findFirst (the fallback) with `firstTerm`. */
  function txFor(containing: { id: string } | null, firstTerm: { id: string }) {
    const termUpdate = jest.fn().mockResolvedValue({});
    const findFirst = jest.fn().mockImplementation((q: { where?: Record<string, unknown> }) =>
      Promise.resolve(q?.where?.startDate ? containing : firstTerm),
    );
    const tx = {
      school: { findFirst: jest.fn().mockResolvedValue({ calendarTemplate: "THREE_TERM" }) },
      academicSession: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: "s1" }),
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: "s1", name: "2025/2026", isCurrent: true, startDate: new Date(), endDate: new Date(),
        }),
        updateMany: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      term: { createMany: jest.fn().mockResolvedValue({ count: 3 }), findFirst, findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({}), update: termUpdate },
    } as unknown as TenantTx;
    return { tx, termUpdate, findFirst };
  }

  it("marks the term CONTAINING TODAY current, not simply the first one", async () => {
    // The mid-year case. Before this, a February onboarding got First Term, and
    // the register lock then used First Term's start date — leaving registers
    // from a term that had already closed editable by anyone.
    const { tx, termUpdate } = txFor({ id: "t2-second" }, { id: "t1-first" });
    await svc(tx).service.createStandardSession(p, { name: "2025/2026", yearStart: "2025-09-01", makeCurrent: true });
    expect(termUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t2-second" } }));
    expect(termUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t1-first" } }));
  });

  it("still queries by a date window rather than by sequence", async () => {
    // Guards the mechanism, not just the outcome: an implementation that ordered
    // by sequence and happened to return the right row would pass the test above.
    const { tx, findFirst } = txFor({ id: "t2" }, { id: "t1" });
    await svc(tx).service.createStandardSession(p, { name: "2025/2026", yearStart: "2025-09-01", makeCurrent: true });
    const q = findFirst.mock.calls[0][0] as { where: { startDate?: unknown; endDate?: unknown } };
    expect(q.where.startDate).toBeDefined();
    expect(q.where.endDate).toBeDefined();
  });

  it("falls back to the first term when today is outside the whole session", async () => {
    // Setting NEXT year up over the holidays. They asked for it explicitly with
    // makeCurrent, so refusing would be worse than picking the opening term.
    const { tx, termUpdate } = txFor(null, { id: "t1-first" });
    await svc(tx).service.createStandardSession(p, { name: "2026/2027", yearStart: "2026-09-01", makeCurrent: true });
    expect(termUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t1-first" } }));
  });

  it("marks no term current at all when makeCurrent was not asked for", async () => {
    const { tx, termUpdate } = txFor({ id: "t2" }, { id: "t1" });
    await svc(tx).service.createStandardSession(p, { name: "2026/2027", yearStart: "2026-09-01" });
    expect(termUpdate).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Editing a session
// =============================================================================
// There was no route for this at all: a session could be created and made
// current, never corrected. The risk it introduces is narrowing a session under
// its own terms, which leaves terms outside their session — a state every date
// rule validates against and none would notice after the fact.

describe("AcademicService.updateSession", () => {
  function txWith(terms: Array<{ name: string; startDate: Date | null; endDate: Date | null }>) {
    const update = jest.fn().mockResolvedValue({});
    const tx = {
      academicSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: "s1", name: "2025/2026", startDate: new Date("2025-09-01"), endDate: new Date("2026-07-31"),
        }),
        findMany: jest.fn().mockResolvedValue([{ id: "s1", name: "2025/2026" }]),
        update,
      },
      term: { findMany: jest.fn().mockResolvedValue(terms) },
    } as unknown as TenantTx;
    return { tx, update };
  }

  const term = (name: string, s: string, e: string) => ({ name, startDate: new Date(s), endDate: new Date(e) });

  it("applies a widened window", async () => {
    const { tx, update } = txWith([term("First Term", "2025-09-08", "2025-12-19")]);
    await svc(tx).service.updateSession(p, "s1", { startDate: "2025-08-01", endDate: "2026-08-31" });
    expect(update).toHaveBeenCalled();
  });

  it("refuses a window that would start AFTER one of its terms", async () => {
    const { tx, update } = txWith([term("First Term", "2025-09-08", "2025-12-19")]);
    await expect(
      svc(tx).service.updateSession(p, "s1", { startDate: "2025-10-01" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a window that would end BEFORE one of its terms", async () => {
    const { tx, update } = txWith([term("Third Term", "2026-04-20", "2026-07-24")]);
    await expect(
      svc(tx).service.updateSession(p, "s1", { endDate: "2026-05-01" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("names the term that blocks it, so the message says what to move", async () => {
    const { tx } = txWith([term("Third Term", "2026-04-20", "2026-07-24")]);
    await expect(svc(tx).service.updateSession(p, "s1", { endDate: "2026-05-01" })).rejects.toThrow(/Third Term/);
  });

  it("ignores undated terms — they occupy no part of the year to fall outside", async () => {
    const { tx, update } = txWith([{ name: "Second Term", startDate: null, endDate: null }]);
    await svc(tx).service.updateSession(p, "s1", { startDate: "2025-10-01" });
    expect(update).toHaveBeenCalled();
  });

  it("renames without requiring the dates to be resent", async () => {
    // A rename that demanded both dates would make the common edit the risky one.
    const { tx, update } = txWith([term("First Term", "2025-09-08", "2025-12-19")]);
    await svc(tx).service.updateSession(p, "s1", { name: "2025/2026 (revised)" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: "2025/2026 (revised)" } }));
  });

  it("404s an unknown session rather than reporting success", async () => {
    const tx = { academicSession: { findFirst: jest.fn().mockResolvedValue(null) } } as unknown as TenantTx;
    await expect(svc(tx).service.updateSession(p, "nope", { name: "x" })).rejects.toThrow(/not found/i);
  });
});

// =============================================================================
// Removing a term added by mistake
// =============================================================================
// Terms could be created and never removed, so a mis-click left a permanent
// phantom in every term picker and in the calendar check. Deleting one that
// carries marks would be far worse, though — the grades would survive with no
// term to belong to.

describe("AcademicService.deleteTerm", () => {
  function txWith(term: { name: string; isCurrent: boolean } | null, counts = [0, 0, 0]) {
    const del = jest.fn().mockResolvedValue({});
    const tx = {
      term: { findFirst: jest.fn().mockResolvedValue(term && { id: "t1", ...term }), delete: del },
      assessment: { count: jest.fn().mockResolvedValue(counts[0]) },
      subjectResult: { count: jest.fn().mockResolvedValue(counts[1]) },
      reportCardRemark: { count: jest.fn().mockResolvedValue(counts[2]) },
    } as unknown as TenantTx;
    return { tx, del };
  }

  it("removes an empty, non-current term", async () => {
    const { tx, del } = txWith({ name: "First Term", isCurrent: false });
    await svc(tx).service.deleteTerm(p, "t1");
    expect(del).toHaveBeenCalledWith({ where: { id: "t1" } });
  });

  it("refuses the CURRENT term — that pointer drives the register lock", async () => {
    const { tx, del } = txWith({ name: "First Term", isCurrent: true });
    await expect(svc(tx).service.deleteTerm(p, "t1")).rejects.toThrow(/current term/i);
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses a term that still has assessments, and says how many", async () => {
    const { tx, del } = txWith({ name: "Second Term", isCurrent: false }, [3, 0, 0]);
    await expect(svc(tx).service.deleteTerm(p, "t1")).rejects.toThrow(/3 assessments/);
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses on recorded results and on remarks too, not only assessments", async () => {
    // Each blocker checked separately: an implementation that only counted
    // assessments would still orphan a term's marks.
    await expect(svc(txWith({ name: "T", isCurrent: false }, [0, 5, 0]).tx).service.deleteTerm(p, "t1")).rejects.toThrow(/5 recorded results/);
    await expect(svc(txWith({ name: "T", isCurrent: false }, [0, 0, 2]).tx).service.deleteTerm(p, "t1")).rejects.toThrow(/2 report-card remarks/);
  });

  it("lists EVERY blocker at once rather than one per attempt", async () => {
    const { tx } = txWith({ name: "T", isCurrent: false }, [1, 1, 1]);
    await expect(svc(tx).service.deleteTerm(p, "t1")).rejects.toThrow(/assessment.*result.*remark/);
  });

  it("404s an unknown term", async () => {
    const { tx } = txWith(null);
    await expect(svc(tx).service.deleteTerm(p, "nope")).rejects.toThrow(/not found/i);
  });
});

// =============================================================================
// Duplicates — the mistake that produced a real school's broken calendar
// =============================================================================
// Nothing stopped two terms sharing a name, which is how a live school ended up
// with two called "First Term" in one session. That is not cosmetic: every term
// picker, report-card header and calendar finding names a term by its name, so
// two identical ones make it impossible to tell which register or which marks
// you are looking at.

describe("duplicate names are refused", () => {
  const sessionTx = (existing: Array<{ id: string; name: string }>) => {
    const create = jest.fn().mockResolvedValue({ id: "new", name: "x", isCurrent: false, startDate: null, endDate: null });
    return {
      tx: { academicSession: { findMany: jest.fn().mockResolvedValue(existing), create } } as unknown as TenantTx,
      create,
    };
  };

  it("refuses a second session with the same name", async () => {
    const { tx, create } = sessionTx([{ id: "s1", name: "2026/2027" }]);
    await expect(svc(tx).service.createSession(p, { name: "2026/2027" })).rejects.toThrow(/already exists/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("compares names case- and space-insensitively", async () => {
    // "first term" and "First Term" are the same term to everyone except a byte
    // comparison, and a school that types one then the other has made the same
    // mistake either way.
    const { tx } = sessionTx([{ id: "s1", name: "2026/2027" }]);
    await expect(svc(tx).service.createSession(p, { name: "  2026/2027  " })).rejects.toThrow(/already exists/i);
  });

  it("allows a genuinely different session name", async () => {
    const { tx, create } = sessionTx([{ id: "s1", name: "2026/2027" }]);
    await svc(tx).service.createSession(p, { name: "2027/2028" });
    expect(create).toHaveBeenCalled();
  });

  const termTx = (siblings: Array<{ id: string; sessionId: string; name: string; sequence: number; startDate: Date | null; endDate: Date | null }>) => {
    const create = jest.fn().mockResolvedValue({ id: "t9", sessionId: "s1", name: "x", sequence: 9, startDate: null, endDate: null, isCurrent: false });
    return {
      tx: {
        academicSession: { findFirst: jest.fn().mockResolvedValue({ id: "s1", startDate: null, endDate: null }) },
        term: { findMany: jest.fn().mockResolvedValue(siblings), create },
      } as unknown as TenantTx,
      create,
    };
  };
  const sib = (name: string, sequence: number) => ({ id: `t${sequence}`, sessionId: "s1", name, sequence, startDate: null, endDate: null });

  it("refuses a second term with the same name in one session", async () => {
    // The exact live defect.
    const { tx, create } = termTx([sib("First Term", 1)]);
    await expect(svc(tx).service.addTerm(p, "s1", { name: "First Term", sequence: 2 })).rejects.toThrow(/already exists in this session/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("already refused a term reusing an existing SEQUENCE — pinning that it still does", async () => {
    // Sequence orders report-card columns and defines "the next term" for
    // roll-over. This was ALREADY guarded by validateTermDates; the test is here
    // so the two guards are visibly separate concerns and neither silently goes.
    const { tx, create } = termTx([sib("First Term", 1)]);
    await expect(svc(tx).service.addTerm(p, "s1", { name: "Second Term", sequence: 1 })).rejects.toThrow(/already uses sequence 1/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("allows a distinct name and sequence", async () => {
    const { tx, create } = termTx([sib("First Term", 1)]);
    await svc(tx).service.addTerm(p, "s1", { name: "Second Term", sequence: 2 });
    expect(create).toHaveBeenCalled();
  });
});

// =============================================================================
// Removing a session added by mistake
// =============================================================================
// Sessions could be created two ways and removed by neither, so a duplicate year
// was permanent. Its terms go with it — safe ONLY because the marks check has
// already proved they are empty.

describe("AcademicService.deleteSession", () => {
  function txWith(session: { name: string; isCurrent: boolean } | null, terms: string[] = [], counts = [0, 0, 0]) {
    const delSession = jest.fn().mockResolvedValue({});
    const delTerms = jest.fn().mockResolvedValue({ count: terms.length });
    const tx = {
      academicSession: { findFirst: jest.fn().mockResolvedValue(session && { id: "s1", ...session }), delete: delSession },
      term: { findMany: jest.fn().mockResolvedValue(terms.map((id) => ({ id }))), deleteMany: delTerms },
      assessment: { count: jest.fn().mockResolvedValue(counts[0]) },
      subjectResult: { count: jest.fn().mockResolvedValue(counts[1]) },
      reportCardRemark: { count: jest.fn().mockResolvedValue(counts[2]) },
    } as unknown as TenantTx;
    return { tx, delSession, delTerms };
  }

  it("removes an empty session together with its terms", async () => {
    const { tx, delSession, delTerms } = txWith({ name: "2027/2028", isCurrent: false }, ["t1", "t2", "t3"]);
    const out = await svc(tx).service.deleteSession(p, "s1");
    expect(delTerms).toHaveBeenCalledWith({ where: { sessionId: "s1" } });
    expect(delSession).toHaveBeenCalledWith({ where: { id: "s1" } });
    expect(out.termsRemoved).toBe(3);
  });

  it("refuses the CURRENT session", async () => {
    const { tx, delSession } = txWith({ name: "2026/2027", isCurrent: true }, ["t1"]);
    await expect(svc(tx).service.deleteSession(p, "s1")).rejects.toThrow(/current session/i);
    expect(delSession).not.toHaveBeenCalled();
  });

  it("refuses when ANY of its terms carries marks — and deletes no terms either", async () => {
    // The consequence that makes this dangerous: a cascade past marks would
    // destroy a year of grades to correct a typo.
    const { tx, delSession, delTerms } = txWith({ name: "2025/2026", isCurrent: false }, ["t1", "t2"], [4, 0, 0]);
    await expect(svc(tx).service.deleteSession(p, "s1")).rejects.toThrow(/4 assessments/);
    expect(delTerms).not.toHaveBeenCalled();
    expect(delSession).not.toHaveBeenCalled();
  });

  it("checks results and remarks too, not only assessments", async () => {
    await expect(svc(txWith({ name: "S", isCurrent: false }, ["t1"], [0, 7, 0]).tx).service.deleteSession(p, "s1")).rejects.toThrow(/7 recorded results/);
    await expect(svc(txWith({ name: "S", isCurrent: false }, ["t1"], [0, 0, 3]).tx).service.deleteSession(p, "s1")).rejects.toThrow(/3 report-card remarks/);
  });

  it("handles a session with no terms at all", async () => {
    const { tx, delSession, delTerms } = txWith({ name: "Empty", isCurrent: false }, []);
    await svc(tx).service.deleteSession(p, "s1");
    expect(delTerms).not.toHaveBeenCalled();
    expect(delSession).toHaveBeenCalled();
  });

  it("404s an unknown session", async () => {
    await expect(svc(txWith(null).tx).service.deleteSession(p, "nope")).rejects.toThrow(/not found/i);
  });
});

// =============================================================================
// Quick-create follows the SCHOOL's year shape
// =============================================================================
// The shape existed in the catalogue and was never consulted: createStandardSession
// called the hard-coded three-term generator, so an American school clicking
// "quick-create" got First/Second/Third Term regardless. Testing the DATA (that
// US resolves to TWO_SEMESTER) proves nothing on its own — this tests the wiring.

describe("AcademicService.createStandardSession — year shape", () => {
  function txFor(schoolTemplate: string | null) {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx = {
      school: { findFirst: jest.fn().mockResolvedValue({ calendarTemplate: schoolTemplate }) },
      academicSession: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: "s1" }),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: "s1", name: "n", isCurrent: false, startDate: new Date(), endDate: new Date() }),
        updateMany: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      term: { createMany, findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    } as unknown as TenantTx;
    const names = () => (createMany.mock.calls[0]?.[0]?.data ?? []).map((t: { name: string }) => t.name);
    return { tx, createMany, names };
  }

  it("builds TWO semesters for a school whose shape is TWO_SEMESTER", async () => {
    const { tx, names } = txFor("TWO_SEMESTER");
    await svc(tx).service.createStandardSession(p, { name: "2026/2027", yearStart: "2026-08-01" });
    expect(names()).toEqual(["Fall Semester", "Spring Semester"]);
  });

  it("still builds THREE terms for a three-term school", async () => {
    // The regression that matters: every school already live is three-term.
    const { tx, names } = txFor("THREE_TERM");
    await svc(tx).service.createStandardSession(p, { name: "2026/2027", yearStart: "2026-09-01" });
    expect(names()).toEqual(["First Term", "Second Term", "Third Term"]);
  });

  it("defaults to three terms when the school has never chosen", async () => {
    const { tx, names } = txFor(null);
    await svc(tx).service.createStandardSession(p, { name: "2026/2027", yearStart: "2026-09-01" });
    expect(names()).toHaveLength(3);
  });

  it("lets an explicit template override the school's own", async () => {
    // A school whose shape differs from its country's norm.
    const { tx, names } = txFor("THREE_TERM");
    await svc(tx).service.createStandardSession(p, { name: "2026/2027", yearStart: "2026-08-01", template: "TWO_SEMESTER" });
    expect(names()).toEqual(["Fall Semester", "Spring Semester"]);
  });

  it("refuses a duplicate session name here too, not only on manual create", async () => {
    const { tx, createMany } = txFor("THREE_TERM");
    (tx as unknown as { academicSession: { findMany: jest.Mock } }).academicSession.findMany.mockResolvedValue([{ id: "old", name: "2026/2027" }]);
    await expect(svc(tx).service.createStandardSession(p, { name: "2026/2027", yearStart: "2026-09-01" })).rejects.toThrow(/already exists/i);
    expect(createMany).not.toHaveBeenCalled();
  });
});
