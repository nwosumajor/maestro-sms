// =============================================================================
// Timetable day structure — pure generator + validator
// =============================================================================
// A school describes its day by COUNT and POSITION — "8 teaching periods, a
// break after period 2 and after period 5" — never by typing raw sequence
// numbers. This module turns that description into the ordered Period rows
// (teaching + break slots, sequence 1..N, computed clock times). Side-effect-free
// and deterministic; the service performs the actual writes.
// =============================================================================

export interface DayBreak {
  /** Insert this break AFTER the Nth teaching period (1-based, 1..teaching-1). */
  afterPeriod: number;
  /** Duration in minutes. */
  minutes: number;
  /** Display name; defaults to "Break". */
  name?: string;
}

export interface DayStructureInput {
  /** Teaching periods in the day, EXCLUDING breaks. */
  teachingPeriods: number;
  /** Day start, "HH:MM" 24h. */
  dayStart: string;
  /** Minutes per teaching period. */
  periodMinutes: number;
  /** Breaks and where they sit. */
  breaks: DayBreak[];
}

export interface GeneratedPeriod {
  name: string;
  sequence: number;
  startTime: string; // "HH:MM"
  endTime: string;
  isBreak: boolean;
}

/** The hard cap on total slots — matches the DB/zod period bound. */
export const MAX_DAY_SLOTS = 50;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const toMinutes = (hhmm: string): number => {
  const m = HHMM.exec(hhmm);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
};

const fromMinutes = (mins: number): string => {
  const wrapped = ((mins % 1440) + 1440) % 1440; // stay within a 24h clock
  const h = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};

/**
 * Validate a day description. Returns a human-readable reason, or null when the
 * description is buildable. Guards exactly the inputs a raw sequence-number field
 * could get wrong: counts, positions, durations, and the total-slot ceiling.
 */
export function validateDayStructure(input: DayStructureInput): string | null {
  if (!Number.isInteger(input.teachingPeriods) || input.teachingPeriods < 1) {
    return "The day needs at least one teaching period.";
  }
  if (Number.isNaN(toMinutes(input.dayStart))) {
    return "The day start time must be a valid HH:MM time.";
  }
  if (!Number.isInteger(input.periodMinutes) || input.periodMinutes < 1 || input.periodMinutes > 600) {
    return "Minutes per period must be between 1 and 600.";
  }
  const seenAfter = new Set<number>();
  for (const b of input.breaks) {
    if (!Number.isInteger(b.afterPeriod) || b.afterPeriod < 1 || b.afterPeriod >= input.teachingPeriods) {
      return `A break must sit after periods 1 to ${input.teachingPeriods - 1} — not after the last period.`;
    }
    if (seenAfter.has(b.afterPeriod)) {
      return `Two breaks cannot both fall after period ${b.afterPeriod}.`;
    }
    seenAfter.add(b.afterPeriod);
    if (!Number.isInteger(b.minutes) || b.minutes < 1 || b.minutes > 600) {
      return "Each break must be between 1 and 600 minutes.";
    }
  }
  const totalSlots = input.teachingPeriods + input.breaks.length;
  if (totalSlots > MAX_DAY_SLOTS) {
    return `The day has ${totalSlots} slots — the maximum is ${MAX_DAY_SLOTS}.`;
  }
  // The generated day must not run past midnight.
  const totalMinutes =
    input.teachingPeriods * input.periodMinutes + input.breaks.reduce((s, b) => s + b.minutes, 0);
  if (toMinutes(input.dayStart) + totalMinutes > 1440) {
    return "The day runs past midnight — shorten the periods, breaks, or start earlier.";
  }
  return null;
}

/**
 * Build the ordered day: each teaching period, with a break slot inserted after
 * the periods that carry one. `sequence` is the global 1..N order (breaks
 * included); teaching periods keep a human "Period k" name numbered among
 * teaching slots only, so a card reads "Period 1, Period 2, Break, Period 3…".
 * Clock times run sequentially from `dayStart`. Assumes a valid input
 * (validateDayStructure passed).
 */
export function generateDayStructure(input: DayStructureInput): GeneratedPeriod[] {
  const breakAfter = new Map<number, DayBreak>();
  for (const b of input.breaks) breakAfter.set(b.afterPeriod, b);

  const out: GeneratedPeriod[] = [];
  let clock = toMinutes(input.dayStart);
  let sequence = 0;
  for (let teaching = 1; teaching <= input.teachingPeriods; teaching += 1) {
    sequence += 1;
    const start = clock;
    clock += input.periodMinutes;
    out.push({ name: `Period ${teaching}`, sequence, startTime: fromMinutes(start), endTime: fromMinutes(clock), isBreak: false });

    const br = breakAfter.get(teaching);
    if (br) {
      sequence += 1;
      const bStart = clock;
      clock += br.minutes;
      out.push({ name: br.name?.trim() || "Break", sequence, startTime: fromMinutes(bStart), endTime: fromMinutes(clock), isBreak: true });
    }
  }
  return out;
}
