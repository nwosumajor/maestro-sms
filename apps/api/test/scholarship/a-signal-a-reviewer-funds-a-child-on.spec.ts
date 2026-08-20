// =============================================================================
// The attendance figure shown to somebody deciding whether to fund a child
// =============================================================================
// A submitted application snapshots SIGNALS for the reviewer: a published grade
// average, an attendance percentage, and what the family still owes. Golden Rule
// #8 keeps them signals rather than a verdict — but a signal that is wrong is
// still what the decision is made on.
//
// The attendance one counted EXCUSED in the denominator and not the numerator,
// so an authorised absence — illness with a note, a bereavement, a hospital
// appointment — counted against the child.
//
// This platform has a stated rule, written where the figure is defined
// (AttendanceRollupService):
//
//   "LATE and EXCUSED count as attending — the pupil was in school, or their
//    absence was authorised. Counting them against attendance would understate
//    it and contradict the report card, which uses the same rule."
//
// The group console, the LMS engagement figure and the parent portal all follow
// it. This signal did not, so it disagreed with the percentage printed on the
// child's own report card, in the direction that costs them.
//
// LATENT rather than live: the demo database holds 147,127 PRESENT, 13,385 LATE
// and 13,189 ABSENT records and not one EXCUSED. The divergence appears the
// first time a school authorises an absence, which is the ordinary thing to do.
// =============================================================================

import { ScholarshipService } from "../../src/scholarship/scholarship.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function make(counts: { PRESENT?: number; LATE?: number; EXCUSED?: number; ABSENT?: number }) {
  const tx = {
    attendanceRecord: {
      groupBy: jest.fn().mockResolvedValue(
        Object.entries(counts).map(([status, n]) => ({ status, _count: { _all: n } })),
      ),
    },
    subjectResult: { findMany: jest.fn().mockResolvedValue([]) },
    invoice: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    disciplineComplaint: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    taskAssignment: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const s = Object.create(ScholarshipService.prototype) as ScholarshipService;
  Object.assign(s, {
    db: { runAsTenant: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)) },
    region: { academicInTx: jest.fn().mockResolvedValue({ grading: { components: undefined } }) },
    audit: { record: jest.fn() },
  });
  const collect = (s as unknown as {
    collectSignals: (t: TenantTx, id: string, sc: string) => Promise<{ attendanceRatePct: number | null }>;
  }).collectSignals.bind(s);
  return { collect, tx };
}

describe("the attendance signal", () => {
  it("counts an EXCUSED absence as attending, like every other figure here", async () => {
    // 80 present, 10 excused, 10 absent. The pupil was authorised to be away on
    // ten days; they should read 90%, not 80%.
    const { collect, tx } = make({ PRESENT: 80, EXCUSED: 10, ABSENT: 10 });
    const out = await collect(tx, "pupil-1", "school-1");
    expect(out.attendanceRatePct).toBe(90);
  });

  it("counts LATE as attending too — they were in school", async () => {
    const { collect, tx } = make({ PRESENT: 70, LATE: 20, ABSENT: 10 });
    const out = await collect(tx, "pupil-1", "school-1");
    expect(out.attendanceRatePct).toBe(90);
  });

  it("still counts an UNauthorised absence against them", async () => {
    // The figure must still mean something: only ABSENT reduces it.
    const { collect, tx } = make({ PRESENT: 50, ABSENT: 50 });
    const out = await collect(tx, "pupil-1", "school-1");
    expect(out.attendanceRatePct).toBe(50);
  });

  it("agrees with the rule the rollup service states", async () => {
    // (present + late + excused) / total — quoted from AttendanceRollupService,
    // which is where this figure is defined for the rest of the platform.
    const counts = { PRESENT: 60, LATE: 15, EXCUSED: 15, ABSENT: 10 };
    const { collect, tx } = make(counts);
    const out = await collect(tx, "pupil-1", "school-1");
    const total = counts.PRESENT + counts.LATE + counts.EXCUSED + counts.ABSENT;
    expect(out.attendanceRatePct).toBe(
      Math.round(((counts.PRESENT + counts.LATE + counts.EXCUSED) / total) * 100),
    );
  });

  it("is null, never zero, when the pupil has no register history", async () => {
    // Zero would read as perfect absence for a child who simply has no records
    // yet — a new pupil, or a school that has not started taking registers.
    const { collect, tx } = make({});
    const out = await collect(tx, "pupil-1", "school-1");
    expect(out.attendanceRatePct).toBeNull();
  });
});

describe("the rule is one rule", () => {
  it("is stated in the rollup service and followed here", () => {
    const read = (rel: string) =>
      require("node:fs").readFileSync(require("node:path").join(__dirname, "../../src", rel), "utf8") as string;
    // If the definition ever moves, this points at where the copy came from.
    expect(read("attendance/attendance-rollup.service.ts")).toMatch(
      /LATE and EXCUSED count as attending/,
    );
    const signal = read("scholarship/scholarship.service.ts");
    expect(signal).toMatch(/const attended = count\("PRESENT"\) \+ count\("LATE"\) \+ count\("EXCUSED"\);/);
    expect(signal).toMatch(/const attTotal = attended \+ count\("ABSENT"\);/);
  });
});
