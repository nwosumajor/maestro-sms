// =============================================================================
// Auto-timetable generator (pure CSP solver)
// =============================================================================
// A deterministic constraint-satisfaction solver. Variables are the individual
// lessons each class must receive (per-offering `lessonsPerWeek` quotas); the
// domain of each lesson is the (day, period) slots it may occupy. Search is
// backtracking with MRV (most-constrained lesson first) under a step budget,
// falling back to a greedy best-effort pass if no complete assignment is found
// in budget — so the caller ALWAYS gets a partial grid plus precise reasons for
// anything unplaceable.
//
// HARD constraints (never violated):
//   - a CLASS has at most one lesson per slot;
//   - a TEACHER teaches at most one class per slot (across ALL classes);
//   - a teacher is never scheduled in a slot they are UNAVAILABLE for;
//   - an offering's PREFERRED ROOM (e.g. Chemistry -> Science Lab) is never
//     double-booked. Offerings without a preferred room get roomId null (the
//     operator assigns rooms manually, exactly as before).
// SOFT constraint (preferred, violated only when necessary):
//   - spread: avoid the same class+subject twice on one day.
//
// Pre-flight DIAGNOSTICS detect structurally impossible demand (a teacher whose
// quota exceeds their available slots, an over-quota class, an over-subscribed
// room) so the UI can say "Mrs. Adeyemi is over-allocated by 5 periods" instead
// of a bare failure. Diagnostics never stop generation — best effort still runs.
//
// It is PURE (no DB, no randomness, stable orderings throughout) so it is
// exhaustively unit-testable; the service persists the result as conflict-free
// TimetableEntry rows.
// =============================================================================

export interface Offering {
  classId: string;
  subjectId: string;
  subject: string; // display name written onto the entry
  teacherId: string;
  lessonsPerWeek: number;
  /** Fixed room this offering must be taught in (null/undefined = no room). */
  preferredRoomId?: string | null;
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
  roomId: string | null;
}

export interface UnplacedLesson {
  classId: string;
  subject: string;
  teacherId: string;
  reason: string;
}

/** Structural over-demand detected BEFORE search. `demand` lessons compete for
 *  `capacity` free slots. The service resolves ids to display names. */
export interface Diagnostic {
  kind: "TEACHER_OVERLOAD" | "CLASS_OVERLOAD" | "ROOM_OVERLOAD";
  teacherId?: string;
  classId?: string;
  roomId?: string;
  demand: number;
  capacity: number;
}

export interface GenerateResult {
  placed: PlacedLesson[];
  unplaced: UnplacedLesson[];
  diagnostics: Diagnostic[];
  /** True when the backtracking search placed EVERY lesson (no fallback). */
  complete: boolean;
}

export interface OccupiedSeed {
  classBusy?: Record<string, Set<string>>;
  teacherBusy?: Record<string, Set<string>>;
  roomBusy?: Record<string, Set<string>>;
}

const slotKey = (day: string, periodId: string) => `${day}|${periodId}`;
/** Key for the teacher-unavailability set: `${teacherId}|${day}|${periodId}`. */
export const unavailableKey = (teacherId: string, day: string, periodId: string) =>
  `${teacherId}|${day}|${periodId}`;

/** Backtracking step budget — bounds worst-case CPU; deterministic. Generously
 *  above what any real school needs (a 40-class grid solves in thousands). */
const DEFAULT_STEP_BUDGET = 200_000;

interface Lesson extends Offering {
  /** Stable identity for deterministic ordering. */
  index: number;
}

interface SearchState {
  slots: Slot[];
  classBusy: Map<string, Set<string>>;
  teacherBusy: Map<string, Set<string>>;
  roomBusy: Map<string, Set<string>>;
  unavailable: ReadonlySet<string>;
  /** `${classId}|${subject}|${day}` -> lessons already that day (spread pref). */
  subjectDay: Map<string, number>;
}

function busySetFrom(seed?: Record<string, Set<string>>): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(seed ?? {})) m.set(k, new Set(v));
  return m;
}

function slotFeasible(l: Lesson, slot: Slot, s: SearchState): boolean {
  const key = slotKey(slot.day, slot.periodId);
  if (s.classBusy.get(key)?.has(l.classId)) return false;
  if (s.teacherBusy.get(key)?.has(l.teacherId)) return false;
  if (s.unavailable.has(unavailableKey(l.teacherId, slot.day, slot.periodId))) return false;
  if (l.preferredRoomId && s.roomBusy.get(key)?.has(l.preferredRoomId)) return false;
  return true;
}

function feasibleSlotIndexes(l: Lesson, s: SearchState): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.slots.length; i++) if (slotFeasible(l, s.slots[i], s)) out.push(i);
  return out;
}

/** Value ordering: spread-preferred slots (no same class+subject that day) first,
 *  then stable slot order — the soft constraint as a preference, not a filter. */
function orderBySpread(l: Lesson, idxs: number[], s: SearchState): number[] {
  return [...idxs].sort((a, b) => {
    const da = s.subjectDay.get(`${l.classId}|${l.subject}|${s.slots[a].day}`) ?? 0;
    const db = s.subjectDay.get(`${l.classId}|${l.subject}|${s.slots[b].day}`) ?? 0;
    return da - db || a - b;
  });
}

function place(l: Lesson, slot: Slot, s: SearchState): void {
  const key = slotKey(slot.day, slot.periodId);
  (s.classBusy.get(key) ?? s.classBusy.set(key, new Set()).get(key)!).add(l.classId);
  (s.teacherBusy.get(key) ?? s.teacherBusy.set(key, new Set()).get(key)!).add(l.teacherId);
  if (l.preferredRoomId)
    (s.roomBusy.get(key) ?? s.roomBusy.set(key, new Set()).get(key)!).add(l.preferredRoomId);
  const dk = `${l.classId}|${l.subject}|${slot.day}`;
  s.subjectDay.set(dk, (s.subjectDay.get(dk) ?? 0) + 1);
}

function unplace(l: Lesson, slot: Slot, s: SearchState): void {
  const key = slotKey(slot.day, slot.periodId);
  s.classBusy.get(key)?.delete(l.classId);
  s.teacherBusy.get(key)?.delete(l.teacherId);
  if (l.preferredRoomId) s.roomBusy.get(key)?.delete(l.preferredRoomId);
  const dk = `${l.classId}|${l.subject}|${slot.day}`;
  const n = (s.subjectDay.get(dk) ?? 1) - 1;
  if (n <= 0) s.subjectDay.delete(dk);
  else s.subjectDay.set(dk, n);
}

/** Backtracking with MRV. Returns the full assignment (lesson index -> slot
 *  index) or null if unsolvable / out of budget. */
function backtrack(
  lessons: Lesson[],
  s: SearchState,
  budget: { steps: number },
): Map<number, number> | null {
  const assignment = new Map<number, number>();
  const unassigned = new Set(lessons.map((l) => l.index));
  const byIndex = new Map(lessons.map((l) => [l.index, l]));

  const step = (): boolean => {
    if (unassigned.size === 0) return true;
    if (--budget.steps <= 0) return false;

    // MRV: the lesson with the fewest feasible slots; ties break on stable index.
    let pick: Lesson | null = null;
    let pickSlots: number[] = [];
    for (const idx of unassigned) {
      const l = byIndex.get(idx)!;
      const feasible = feasibleSlotIndexes(l, s);
      if (feasible.length === 0) return false; // dead end — some lesson unplaceable
      if (!pick || feasible.length < pickSlots.length) {
        pick = l;
        pickSlots = feasible;
        if (feasible.length === 1) break; // can't get more constrained
      }
    }
    const l = pick!;
    unassigned.delete(l.index);
    for (const si of orderBySpread(l, pickSlots, s)) {
      // Re-check: an earlier sibling choice this frame can't have changed state,
      // but feasibility was computed before recursion siblings — state is ours.
      if (!slotFeasible(l, s.slots[si], s)) continue;
      place(l, s.slots[si], s);
      assignment.set(l.index, si);
      if (step()) return true;
      if (budget.steps <= 0) {
        // Budget exhausted mid-search: leave partial assignment for the caller
        // to discard; signal failure upward without further exploration.
        unplace(l, s.slots[si], s);
        assignment.delete(l.index);
        unassigned.add(l.index);
        return false;
      }
      unplace(l, s.slots[si], s);
      assignment.delete(l.index);
    }
    unassigned.add(l.index);
    return false;
  };

  return step() ? assignment : null;
}

/** Why can't this lesson go anywhere? Inspect each slot's blocking constraint
 *  and report the dominant one — evidence for the operator, not a bare "no". */
function unplacedReason(l: Lesson, s: SearchState): string {
  let classBlocked = 0;
  let teacherBlocked = 0;
  let unavailableBlocked = 0;
  let roomBlocked = 0;
  for (const slot of s.slots) {
    const key = slotKey(slot.day, slot.periodId);
    if (s.classBusy.get(key)?.has(l.classId)) classBlocked++;
    else if (s.unavailable.has(unavailableKey(l.teacherId, slot.day, slot.periodId))) unavailableBlocked++;
    else if (s.teacherBusy.get(key)?.has(l.teacherId)) teacherBlocked++;
    else if (l.preferredRoomId && s.roomBusy.get(key)?.has(l.preferredRoomId)) roomBlocked++;
  }
  const total = s.slots.length;
  if (classBlocked === total) return "the class already has a lesson in every slot";
  const parts: string[] = [];
  if (unavailableBlocked > 0) parts.push(`${unavailableBlocked} blocked by teacher unavailability`);
  if (teacherBlocked > 0) parts.push(`${teacherBlocked} by the teacher's other lessons`);
  if (roomBlocked > 0) parts.push(`${roomBlocked} by the preferred room being booked`);
  if (classBlocked > 0) parts.push(`${classBlocked} by the class's own lessons`);
  return parts.length
    ? `no free slot (of ${total}: ${parts.join(", ")})`
    : "no free slot without a class/teacher/room clash";
}

/** Structural over-demand checks, run BEFORE search on the seeded state. */
function preflight(lessons: Lesson[], s: SearchState): Diagnostic[] {
  const out: Diagnostic[] = [];

  // Teacher: quota demand vs slots where they are available and not pre-booked.
  const teacherDemand = new Map<string, number>();
  for (const l of lessons) teacherDemand.set(l.teacherId, (teacherDemand.get(l.teacherId) ?? 0) + 1);
  for (const [teacherId, demand] of teacherDemand) {
    let capacity = 0;
    for (const slot of s.slots) {
      const key = slotKey(slot.day, slot.periodId);
      if (s.unavailable.has(unavailableKey(teacherId, slot.day, slot.periodId))) continue;
      if (s.teacherBusy.get(key)?.has(teacherId)) continue;
      capacity++;
    }
    if (demand > capacity) out.push({ kind: "TEACHER_OVERLOAD", teacherId, demand, capacity });
  }

  // Class: total quota vs slots not already taken by kept entries.
  const classDemand = new Map<string, number>();
  for (const l of lessons) classDemand.set(l.classId, (classDemand.get(l.classId) ?? 0) + 1);
  for (const [classId, demand] of classDemand) {
    let capacity = 0;
    for (const slot of s.slots) {
      if (!s.classBusy.get(slotKey(slot.day, slot.periodId))?.has(classId)) capacity++;
    }
    if (demand > capacity) out.push({ kind: "CLASS_OVERLOAD", classId, demand, capacity });
  }

  // Preferred room: demand vs slots the room is not pre-booked in.
  const roomDemand = new Map<string, number>();
  for (const l of lessons) {
    if (l.preferredRoomId) roomDemand.set(l.preferredRoomId, (roomDemand.get(l.preferredRoomId) ?? 0) + 1);
  }
  for (const [roomId, demand] of roomDemand) {
    let capacity = 0;
    for (const slot of s.slots) {
      if (!s.roomBusy.get(slotKey(slot.day, slot.periodId))?.has(roomId)) capacity++;
    }
    if (demand > capacity) out.push({ kind: "ROOM_OVERLOAD", roomId, demand, capacity });
  }

  return out;
}

/**
 * @param offerings   what each class must be taught + by whom + how often (+ room)
 * @param slots       every (day, period) cell available
 * @param occupied    pre-existing bookings to respect (kept entries)
 * @param teacherUnavailable  keys from `unavailableKey()` — slots a teacher can't teach
 * @param stepBudget  backtracking bound (tests may shrink it to force the fallback)
 */
export function generateTimetable(
  offerings: Offering[],
  slots: Slot[],
  occupied?: OccupiedSeed,
  teacherUnavailable?: ReadonlySet<string>,
  stepBudget: number = DEFAULT_STEP_BUDGET,
): GenerateResult {
  const state: SearchState = {
    slots,
    classBusy: busySetFrom(occupied?.classBusy),
    teacherBusy: busySetFrom(occupied?.teacherBusy),
    roomBusy: busySetFrom(occupied?.roomBusy),
    unavailable: teacherUnavailable ?? new Set(),
    subjectDay: new Map(),
  };

  // Expand offerings into individual lessons. Hardest-first (most lessons) is a
  // good static order for the greedy fallback; stable sort keeps determinism.
  const lessons: Lesson[] = [];
  let index = 0;
  for (const o of [...offerings].sort((a, b) => b.lessonsPerWeek - a.lessonsPerWeek)) {
    for (let i = 0; i < Math.max(0, o.lessonsPerWeek); i++) lessons.push({ ...o, index: index++ });
  }

  const diagnostics = preflight(lessons, state);

  const toPlaced = (l: Lesson, slot: Slot): PlacedLesson => ({
    classId: l.classId,
    subject: l.subject,
    teacherId: l.teacherId,
    day: slot.day,
    periodId: slot.periodId,
    roomId: l.preferredRoomId ?? null,
  });

  // Phase 1: full CSP search — only worth attempting when nothing is structurally
  // impossible (a preflight overload means no complete assignment can exist).
  if (diagnostics.length === 0) {
    const assignment = backtrack(lessons, state, { steps: stepBudget });
    if (assignment) {
      const placed = lessons.map((l) => toPlaced(l, slots[assignment.get(l.index)!]));
      return { placed, unplaced: [], diagnostics, complete: true };
    }
    // Reset mutated state for the fallback pass.
    state.classBusy = busySetFrom(occupied?.classBusy);
    state.teacherBusy = busySetFrom(occupied?.teacherBusy);
    state.roomBusy = busySetFrom(occupied?.roomBusy);
    state.subjectDay = new Map();
  }

  // Phase 2: greedy best-effort with dynamic MRV — always place the MOST
  // CONSTRAINED remaining lesson next (fewest feasible slots; stable tiebreak),
  // so an unconstrained lesson never squats on a constrained teacher's only
  // slot. Whatever still can't fit is reported with its blocking constraint.
  const placed: PlacedLesson[] = [];
  const unplaced: UnplacedLesson[] = [];
  const remaining = [...lessons];
  while (remaining.length > 0) {
    let pickAt = 0;
    let pickFeasible: number[] | null = null;
    for (let i = 0; i < remaining.length; i++) {
      const feasible = feasibleSlotIndexes(remaining[i], state);
      if (pickFeasible === null || feasible.length < pickFeasible.length) {
        pickAt = i;
        pickFeasible = feasible;
        if (feasible.length === 0) break; // report it now; state won't improve
      }
    }
    const [l] = remaining.splice(pickAt, 1);
    const ordered = orderBySpread(l, pickFeasible ?? [], state);
    if (ordered.length > 0) {
      const slot = slots[ordered[0]];
      place(l, slot, state);
      placed.push(toPlaced(l, slot));
    } else {
      unplaced.push({
        classId: l.classId,
        subject: l.subject,
        teacherId: l.teacherId,
        reason: unplacedReason(l, state),
      });
    }
  }
  return { placed, unplaced, diagnostics, complete: false };
}
