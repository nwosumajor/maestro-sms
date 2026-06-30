// =============================================================================
// Auto-timetable generator (pure)
// =============================================================================
// A deterministic greedy/backtracking scheduler. Given a class's subject offerings
// (each: subject + teacher + lessons-per-week) and the available (day, period)
// slots, it assigns lessons to slots subject to TWO hard constraints:
//   - a CLASS has at most one lesson per slot (it can't be in two places at once);
//   - a TEACHER teaches at most one class per slot (across ALL classes).
// It is PURE (no DB, no randomness beyond a stable order) so it is exhaustively
// unit-testable; the service persists the result as conflict-free TimetableEntry
// rows. Unplaceable lessons are returned for the operator to resolve manually.
// =============================================================================

export interface Offering {
  classId: string;
  subjectId: string;
  subject: string; // display name written onto the entry
  teacherId: string;
  lessonsPerWeek: number;
}

export interface Slot {
  day: string; // DayOfWeek value
  periodId: string;
}

export interface PlacedLesson {
  classId: string;
  subject: string;
  teacherId: string;
  day: string;
  periodId: string;
}

export interface UnplacedLesson {
  classId: string;
  subject: string;
  teacherId: string;
  reason: string;
}

export interface GenerateResult {
  placed: PlacedLesson[];
  unplaced: UnplacedLesson[];
}

const slotKey = (day: string, periodId: string) => `${day}|${periodId}`;

/**
 * @param offerings  what each class must be taught + by whom + how often
 * @param slots      every (day, period) cell available
 * @param occupied   pre-existing bookings to respect (e.g. already-placed entries):
 *                   classBusy[slotKey] = set of classIds, teacherBusy[slotKey] = set of teacherIds
 */
export function generateTimetable(
  offerings: Offering[],
  slots: Slot[],
  occupied?: { classBusy?: Record<string, Set<string>>; teacherBusy?: Record<string, Set<string>> },
): GenerateResult {
  const classBusy = new Map<string, Set<string>>(); // slotKey -> classIds
  const teacherBusy = new Map<string, Set<string>>(); // slotKey -> teacherIds
  // Seed with any pre-existing bookings.
  for (const [k, v] of Object.entries(occupied?.classBusy ?? {})) classBusy.set(k, new Set(v));
  for (const [k, v] of Object.entries(occupied?.teacherBusy ?? {})) teacherBusy.set(k, new Set(v));

  const placed: PlacedLesson[] = [];
  const unplaced: UnplacedLesson[] = [];

  // Expand offerings into individual lessons. Hardest-first (most lessons) tends to
  // pack better; stable sort keeps it deterministic.
  const lessons: Offering[] = [];
  for (const o of [...offerings].sort((a, b) => b.lessonsPerWeek - a.lessonsPerWeek)) {
    for (let i = 0; i < Math.max(0, o.lessonsPerWeek); i++) lessons.push(o);
  }

  for (const lesson of lessons) {
    let done = false;
    for (const slot of slots) {
      const key = slotKey(slot.day, slot.periodId);
      const cls = classBusy.get(key);
      const tch = teacherBusy.get(key);
      const classFree = !cls?.has(lesson.classId);
      const teacherFree = !tch?.has(lesson.teacherId);
      // Also avoid scheduling the SAME class+subject twice in one day (spread out).
      const sameSubjectSameDay = placed.some(
        (p) => p.classId === lesson.classId && p.subject === lesson.subject && p.day === slot.day,
      );
      if (classFree && teacherFree && !sameSubjectSameDay) {
        (cls ?? classBusy.set(key, new Set()).get(key)!).add(lesson.classId);
        (tch ?? teacherBusy.set(key, new Set()).get(key)!).add(lesson.teacherId);
        placed.push({ classId: lesson.classId, subject: lesson.subject, teacherId: lesson.teacherId, day: slot.day, periodId: slot.periodId });
        done = true;
        break;
      }
    }
    if (!done) {
      // Relax the same-day spread constraint on a second pass for this lesson.
      for (const slot of slots) {
        const key = slotKey(slot.day, slot.periodId);
        const classFree = !classBusy.get(key)?.has(lesson.classId);
        const teacherFree = !teacherBusy.get(key)?.has(lesson.teacherId);
        if (classFree && teacherFree) {
          (classBusy.get(key) ?? classBusy.set(key, new Set()).get(key)!).add(lesson.classId);
          (teacherBusy.get(key) ?? teacherBusy.set(key, new Set()).get(key)!).add(lesson.teacherId);
          placed.push({ classId: lesson.classId, subject: lesson.subject, teacherId: lesson.teacherId, day: slot.day, periodId: slot.periodId });
          done = true;
          break;
        }
      }
    }
    if (!done) {
      unplaced.push({ classId: lesson.classId, subject: lesson.subject, teacherId: lesson.teacherId, reason: "no free slot without a class/teacher clash" });
    }
  }

  return { placed, unplaced };
}
