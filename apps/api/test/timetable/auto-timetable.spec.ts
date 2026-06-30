// =============================================================================
// generateTimetable — pure CSP solver unit tests
// =============================================================================
// Proves the two hard constraints: a class is never double-booked, a teacher is
// never double-booked, and that impossible demand surfaces as `unplaced`.

import { generateTimetable, type Offering, type Slot } from "../../src/timetable/auto-timetable";

function slots(days: string[], periods: string[]): Slot[] {
  const out: Slot[] = [];
  for (const day of days) for (const periodId of periods) out.push({ day, periodId });
  return out;
}

function noClashes(placed: { classId: string; teacherId: string; day: string; periodId: string }[]) {
  const classSeen = new Set<string>();
  const teacherSeen = new Set<string>();
  for (const p of placed) {
    const ck = `${p.classId}|${p.day}|${p.periodId}`;
    const tk = `${p.teacherId}|${p.day}|${p.periodId}`;
    if (classSeen.has(ck)) return false;
    if (teacherSeen.has(tk)) return false;
    classSeen.add(ck);
    teacherSeen.add(tk);
  }
  return true;
}

describe("generateTimetable", () => {
  it("places every lesson with no class/teacher clash when capacity is ample", () => {
    const offerings: Offering[] = [
      { classId: "c1", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 3 },
      { classId: "c1", subjectId: "s2", subject: "English", teacherId: "t2", lessonsPerWeek: 3 },
      { classId: "c2", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 3 },
    ];
    const res = generateTimetable(offerings, slots(["MON", "TUE", "WED"], ["p1", "p2"]));
    expect(res.unplaced).toHaveLength(0);
    expect(res.placed).toHaveLength(9);
    expect(noClashes(res.placed)).toBe(true);
  });

  it("never double-books a shared teacher across two classes", () => {
    // t1 teaches both c1 and c2; total 4 lessons need 4 distinct slots for t1.
    const offerings: Offering[] = [
      { classId: "c1", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 2 },
      { classId: "c2", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 2 },
    ];
    const res = generateTimetable(offerings, slots(["MON", "TUE"], ["p1", "p2"]));
    expect(noClashes(res.placed)).toBe(true);
  });

  it("reports unplaced lessons when demand exceeds a teacher's available slots", () => {
    // t1 needs 5 lessons but only 4 slots exist -> at least one unplaced.
    const offerings: Offering[] = [
      { classId: "c1", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 5 },
    ];
    const res = generateTimetable(offerings, slots(["MON", "TUE"], ["p1", "p2"]));
    expect(res.placed.length).toBe(4);
    expect(res.unplaced.length).toBe(1);
    expect(noClashes(res.placed)).toBe(true);
  });

  it("respects pre-existing bookings (occupied seed)", () => {
    const offerings: Offering[] = [{ classId: "c1", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 1 }];
    // MON|p1 already taken for class c1 — solver must avoid it.
    const res = generateTimetable(offerings, slots(["MON"], ["p1", "p2"]), {
      classBusy: { "MON|p1": new Set(["c1"]) },
    });
    expect(res.placed).toHaveLength(1);
    expect(res.placed[0].periodId).toBe("p2");
  });
});
