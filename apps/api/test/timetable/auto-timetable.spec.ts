// =============================================================================
// generateTimetable — pure CSP solver unit tests
// =============================================================================
// Proves the hard constraints (class / teacher / preferred-room never
// double-booked, teacher unavailability respected), per-offering quotas, the
// backtracking advantage over greedy first-fit, preflight overload diagnostics,
// determinism, and that impossible demand surfaces as `unplaced` with a reason.

import { generateTimetable, unavailableKey, type Offering, type Slot } from "../../src/timetable/auto-timetable";

function slots(days: string[], periods: string[]): Slot[] {
  const out: Slot[] = [];
  for (const day of days) for (const periodId of periods) out.push({ day, periodId });
  return out;
}

function noClashes(
  placed: { classId: string; teacherId: string; day: string; periodId: string; roomId: string | null }[],
) {
  const classSeen = new Set<string>();
  const teacherSeen = new Set<string>();
  const roomSeen = new Set<string>();
  for (const p of placed) {
    const ck = `${p.classId}|${p.day}|${p.periodId}`;
    const tk = `${p.teacherId}|${p.day}|${p.periodId}`;
    if (classSeen.has(ck)) return false;
    if (teacherSeen.has(tk)) return false;
    classSeen.add(ck);
    teacherSeen.add(tk);
    if (p.roomId) {
      const rk = `${p.roomId}|${p.day}|${p.periodId}`;
      if (roomSeen.has(rk)) return false;
      roomSeen.add(rk);
    }
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
    expect(res.complete).toBe(true);
    expect(res.diagnostics).toHaveLength(0);
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

  it("reports unplaced lessons + a TEACHER_OVERLOAD diagnostic when demand exceeds a teacher's slots", () => {
    // t1 needs 5 lessons but only 4 slots exist -> structurally impossible.
    const offerings: Offering[] = [
      { classId: "c1", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 5 },
    ];
    const res = generateTimetable(offerings, slots(["MON", "TUE"], ["p1", "p2"]));
    expect(res.placed.length).toBe(4);
    expect(res.unplaced.length).toBe(1);
    expect(res.complete).toBe(false);
    expect(res.diagnostics).toContainEqual({ kind: "TEACHER_OVERLOAD", teacherId: "t1", demand: 5, capacity: 4 });
    // CLASS_OVERLOAD too: c1 wants 5 lessons into 4 slots.
    expect(res.diagnostics).toContainEqual({ kind: "CLASS_OVERLOAD", classId: "c1", demand: 5, capacity: 4 });
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

  it("never schedules a teacher into a slot they are unavailable for", () => {
    const offerings: Offering[] = [{ classId: "c1", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 1 }];
    const res = generateTimetable(
      offerings,
      slots(["MON"], ["p1", "p2"]),
      undefined,
      new Set([unavailableKey("t1", "MON", "p1")]),
    );
    expect(res.placed).toHaveLength(1);
    expect(res.placed[0].periodId).toBe("p2");
  });

  it("honours per-offering lessonsPerWeek quotas", () => {
    const offerings: Offering[] = [
      { classId: "c1", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 3 },
      { classId: "c1", subjectId: "s2", subject: "Art", teacherId: "t2", lessonsPerWeek: 1 },
    ];
    const res = generateTimetable(offerings, slots(["MON", "TUE", "WED"], ["p1", "p2"]));
    expect(res.placed.filter((p) => p.subject === "Math")).toHaveLength(3);
    expect(res.placed.filter((p) => p.subject === "Art")).toHaveLength(1);
  });

  it("assigns and never double-books a preferred room", () => {
    const offerings: Offering[] = [
      { classId: "c1", subjectId: "s1", subject: "Chemistry", teacherId: "t1", lessonsPerWeek: 1, preferredRoomId: "lab" },
      { classId: "c2", subjectId: "s1", subject: "Chemistry", teacherId: "t2", lessonsPerWeek: 1, preferredRoomId: "lab" },
    ];
    const res = generateTimetable(offerings, slots(["MON"], ["p1", "p2"]));
    expect(res.unplaced).toHaveLength(0);
    expect(res.placed.every((p) => p.roomId === "lab")).toBe(true);
    expect(noClashes(res.placed)).toBe(true);
    // The same two offerings into ONE slot: the room makes it impossible.
    const clash = generateTimetable(offerings, slots(["MON"], ["p1"]));
    expect(clash.placed).toHaveLength(1);
    expect(clash.unplaced).toHaveLength(1);
    expect(clash.diagnostics).toContainEqual({ kind: "ROOM_OVERLOAD", roomId: "lab", demand: 2, capacity: 1 });
  });

  it("backtracks to solve instances greedy first-fit cannot", () => {
    // Two lessons for class c1 into two slots. t1 is only available at MON|p1;
    // greedy places t2's lesson there first (first fit) and dead-ends t1's.
    // The CSP's MRV ordering assigns the constrained lesson first instead.
    const offerings: Offering[] = [
      { classId: "c1", subjectId: "s1", subject: "English", teacherId: "t2", lessonsPerWeek: 1 },
      { classId: "c1", subjectId: "s2", subject: "Math", teacherId: "t1", lessonsPerWeek: 1 },
    ];
    const res = generateTimetable(
      offerings,
      slots(["MON"], ["p1", "p2"]),
      undefined,
      new Set([unavailableKey("t1", "MON", "p2")]),
    );
    expect(res.unplaced).toHaveLength(0);
    expect(res.complete).toBe(true);
    expect(res.placed.find((p) => p.subject === "Math")!.periodId).toBe("p1");
    expect(res.placed.find((p) => p.subject === "English")!.periodId).toBe("p2");
  });

  it("spreads a subject across days when possible", () => {
    const offerings: Offering[] = [
      { classId: "c1", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 3 },
    ];
    const res = generateTimetable(offerings, slots(["MON", "TUE", "WED"], ["p1", "p2"]));
    expect(new Set(res.placed.map((p) => p.day)).size).toBe(3);
  });

  it("falls back to a best-effort greedy grid when the step budget is exhausted", () => {
    const offerings: Offering[] = [
      { classId: "c1", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 2 },
      { classId: "c2", subjectId: "s1", subject: "Math", teacherId: "t2", lessonsPerWeek: 2 },
    ];
    const res = generateTimetable(offerings, slots(["MON", "TUE"], ["p1", "p2"]), undefined, undefined, 1);
    expect(res.complete).toBe(false);
    expect(res.placed.length).toBeGreaterThan(0);
    expect(noClashes(res.placed)).toBe(true);
  });

  it("is deterministic: identical inputs produce identical grids", () => {
    const offerings: Offering[] = [
      { classId: "c1", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 3 },
      { classId: "c2", subjectId: "s2", subject: "English", teacherId: "t2", lessonsPerWeek: 2 },
      { classId: "c2", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 2 },
    ];
    const sl = slots(["MON", "TUE", "WED"], ["p1", "p2"]);
    expect(generateTimetable(offerings, sl)).toEqual(generateTimetable(offerings, sl));
  });

  it("gives an unplaced lesson a reason naming the blocking constraint", () => {
    // t1's only slot is consumed by their other lesson in another class.
    const offerings: Offering[] = [
      { classId: "c1", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 1 },
      { classId: "c2", subjectId: "s1", subject: "Math", teacherId: "t1", lessonsPerWeek: 1 },
    ];
    const res = generateTimetable(offerings, slots(["MON"], ["p1"]));
    expect(res.unplaced).toHaveLength(1);
    expect(res.unplaced[0].reason).toContain("teacher");
  });
});
