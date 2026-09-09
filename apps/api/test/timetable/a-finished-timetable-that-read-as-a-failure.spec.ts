// =============================================================================
// "Already scheduled" and "could not be scheduled" are opposite facts
// =============================================================================
// `generate` respects existing entries rather than wiping them, and seeds its
// busy-sets from them. So on a re-run over a FINISHED grid every slot is busy
// and every offering's lessons come back as UNPLACED, with the reason "the class
// already has a lesson in every slot" — which is exactly what an OVER-ALLOCATED
// school sees. Two opposite facts rendered identically, on the one screen an
// operator uses to decide whether their timetable worked.
//
// It needs nobody to do anything odd to reach it. Measured at 5,000-school
// scale on a 60-class secondary: `generate` takes ~110 s, nginx times the
// request out at its 60 s default and returns a raw 504 HTML page, the server
// finishes and writes all 2,400 lessons, and the operator — who saw the 504 —
// presses the button again. That retry reported:
//
//     placed: 0   complete: false   unplaced: 2400
//     "the class already has a lesson in every slot"
//
// over a COMPLETE timetable. After: `placed: 0, alreadyPlaced: 2400,
// complete: true, unplaced: 0`.
//
// The fix must not silence a REAL failure, which is what the second case pins:
// a genuinely impossible timetable still reports its unplaced lessons.
// =============================================================================

import { TimetableService } from "../../src/timetable/timetable.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "admin", roles: ["school_admin"], permissions: [] };

/**
 * A school with `classes` classes, `subjects` subjects, `perWeek` lessons each,
 * and `existing` entries already on the grid for those same offerings.
 */
function harness(opts: { classes: number; subjects: number; perWeek: number; periods: number; existingPerOffering: number }) {
  const classIds = Array.from({ length: opts.classes }, (_, i) => `c${i}`);
  const subjectIds = Array.from({ length: opts.subjects }, (_, i) => `s${i}`);
  const periodIds = Array.from({ length: opts.periods }, (_, i) => `p${i}`);
  const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

  const offerings = classIds.flatMap((classId) =>
    subjectIds.map((subjectId) => ({
      classId, subjectId, teacherId: `t-${classId}-${subjectId}`,
      lessonsPerWeek: opts.perWeek, preferredRoomId: null,
    })),
  );
  // Existing entries, laid out so they never clash with one another.
  const entries: Array<{ classId: string; subjectId: string; teacherId: string; dayOfWeek: string; periodId: string; roomId: string | null }> = [];
  for (const o of offerings) {
    for (let n = 0; n < opts.existingPerOffering; n++) {
      const slot = entries.filter((e) => e.classId === o.classId).length;
      entries.push({
        classId: o.classId, subjectId: o.subjectId, teacherId: o.teacherId,
        dayOfWeek: DAYS[Math.floor(slot / opts.periods) % DAYS.length],
        periodId: periodIds[slot % opts.periods], roomId: null,
      });
    }
  }

  const tx = {
    period: { findMany: jest.fn(async () => periodIds.map((id, i) => ({ id, isBreak: false, sequence: i }))) },
    classSubjectTeacher: { findMany: jest.fn(async () => offerings) },
    subject: { findMany: jest.fn(async () => subjectIds.map((id) => ({ id, name: id }))) },
    class: { findMany: jest.fn(async () => classIds.map((id) => ({ id, name: id }))) },
    user: { findMany: jest.fn(async () => []) },
    teacherUnavailability: { findMany: jest.fn(async () => []) },
    timetableEntry: {
      findMany: jest.fn(async () => entries),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
      // The COUNT the fix relies on, derived from the same fixture the busy-sets
      // are built from — a double answering a constant would let the two views
      // of the grid disagree, which is the bug this guards.
      groupBy: jest.fn(async () => {
        const by = new Map<string, number>();
        for (const e of entries) {
          const k = `${e.classId}|${e.subjectId}|${e.teacherId}`;
          by.set(k, (by.get(k) ?? 0) + 1);
        }
        return [...by].map(([k, n]) => {
          const [classId, subjectId, teacherId] = k.split("|");
          return { classId, subjectId, teacherId, _count: { _all: n } };
        });
      }),
    },
    room: { findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const svc = new TimetableService(db as never, { record: jest.fn() } as never, { refreshFor: jest.fn() } as never);
  return { svc, tx };
}

describe("re-generating a timetable", () => {
  it("reports a FINISHED grid as finished, not as 100% unplaced", async () => {
    // 4 classes x 2 subjects x 3 lessons = 24, all already on the grid.
    const { svc } = harness({ classes: 4, subjects: 2, perWeek: 3, periods: 8, existingPerOffering: 3 });
    const out = await svc.generate(staff, {});
    expect(out.alreadyPlaced).toBe(24);
    expect(out.unplaced).toHaveLength(0);
    expect(out.complete).toBe(true);
    expect(out.placed).toBe(0);
  });

  it("still places the REMAINDER when a grid is only partly built", async () => {
    // 1 of each offering's 3 lessons is already there; 2 each remain.
    const { svc } = harness({ classes: 2, subjects: 2, perWeek: 3, periods: 8, existingPerOffering: 1 });
    const out = await svc.generate(staff, {});
    expect(out.alreadyPlaced).toBe(4); // 2 classes x 2 subjects x 1
    expect(out.placed).toBe(8); // the outstanding 2 each
    expect(out.complete).toBe(true);
  });

  it("does NOT silence a real failure — an impossible timetable still says so", async () => {
    // 1 class, 2 subjects, 9 lessons each = 18 into 5 days x 2 periods = 10.
    const { svc } = harness({ classes: 1, subjects: 2, perWeek: 9, periods: 2, existingPerOffering: 0 });
    const out = await svc.generate(staff, {});
    expect(out.complete).toBe(false);
    expect(out.unplaced.length).toBeGreaterThan(0);
    expect(out.alreadyPlaced).toBe(0);
  });

  it("counts nothing as already-placed when the caller asked to REPLACE", async () => {
    // `replace` clears the targeted classes first, so nothing is carried over —
    // reporting otherwise would credit lessons that are about to be deleted.
    const { svc } = harness({ classes: 2, subjects: 2, perWeek: 2, periods: 8, existingPerOffering: 2 });
    const out = await svc.generate(staff, { replace: true });
    expect(out.alreadyPlaced).toBe(0);
    expect(out.placed).toBe(8);
  });
});
