// =============================================================================
// Class streams and arms
// =============================================================================
// A senior class is not one flat cohort. SS3 splits by STREAM — Science, Art,
// Commercial — and a large school splits each stream again into ARMS (SS3
// Science A, B, C) purely because one room cannot hold two hundred pupils.
//
// Both were previously encoded in the class NAME and nowhere else, which meant:
//   - "all SS3 Science parents" could not be expressed, only guessed at with a
//     string match;
//   - the same stream was spelled differently across schools, and across
//     sessions in one school ("SS3 Sci A", "SS3-SCIENCE-A", "SS3 Science 1");
//   - ranking within a stream — the comparison schools actually make — had
//     nothing to group by.
//
// So they are STRUCTURED fields on Class, both nullable: a junior class has no
// stream, and a stream with only one class has no arm. Nullable means every
// existing school is untouched, the same posture as region and calendar.
//
// DELIBERATELY NOT a new entity. The class remains the unit of enrolment,
// register, timetable, results and report card; a parent "year group" row would
// ripple into all of those and buy nothing. A pupil's stream is their CLASS's
// stream and is never copied onto the pupil — duplicated knowledge diverges.
// =============================================================================

/** The streams a senior class can belong to. GENERAL is the honest answer for
 *  a school that does not stream at all, or a class that predates the split. */
export const CLASS_STREAMS = ["SCIENCE", "ART", "COMMERCIAL", "GENERAL"] as const;
export type ClassStream = (typeof CLASS_STREAMS)[number];

export const CLASS_STREAM_LABELS: Record<ClassStream, string> = {
  SCIENCE: "Science",
  ART: "Art",
  COMMERCIAL: "Commercial",
  GENERAL: "General",
};

/**
 * Arms are a FIXED list, chosen not typed.
 *
 * A free-text arm is how you end up with "A", "a", "A " and "1" as four
 * different arms of the same stream — which then group wrongly, rank wrongly
 * and read wrongly on a report card. Ten covers a very large year group; a
 * school needing more has an organisational problem this field cannot fix.
 */
export const CLASS_ARMS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
export type ClassArm = (typeof CLASS_ARMS)[number];

/** How a stage reads at the front of a class name. */
const STAGE_PREFIX: Record<string, string> = {
  PRE_PRIMARY: "Nursery",
  PRIMARY: "Primary",
  JUNIOR_SECONDARY: "JSS",
  SENIOR_SECONDARY: "SS",
};

export interface ClassNaming {
  stage?: string | null;
  level?: number | null;
  stream?: string | null;
  arm?: string | null;
}

/**
 * Compose the class name from what was CHOSEN, so the name and the structured
 * fields can never disagree.
 *
 * This is what the create form shows and stores, rather than asking somebody to
 * type "SS3 Science A" and hoping. Returns "" when there is not enough to name
 * anything — the caller then keeps whatever the school typed, which is how
 * house-named classes ("Blue House") still work.
 */
export function composeClassName(c: ClassNaming): string {
  const prefix = c.stage ? (STAGE_PREFIX[c.stage] ?? "") : "";
  if (!prefix || c.level == null) return "";
  const stream = c.stream && c.stream !== "GENERAL" ? ` ${CLASS_STREAM_LABELS[c.stream as ClassStream] ?? c.stream}` : "";
  const arm = c.arm ? ` ${c.arm}` : "";
  // "Primary 4" and "Nursery 2" read with a space; "SS3" and "JSS1" do not.
  const joiner = prefix === "SS" || prefix === "JSS" ? "" : " ";
  return `${prefix}${joiner}${c.level}${stream}${arm}`;
}

/** Null-safe validation for an incoming stream. Null/absent is always fine. */
export function isClassStream(v: unknown): v is ClassStream {
  return typeof v === "string" && (CLASS_STREAMS as readonly string[]).includes(v);
}

/** Null-safe validation for an incoming arm. */
export function isClassArm(v: unknown): v is ClassArm {
  return typeof v === "string" && (CLASS_ARMS as readonly string[]).includes(v);
}

/**
 * Do these two classes belong to the same stream group — the set an arm split
 * came from? Used to copy a subject set across every arm at once.
 *
 * Level and stage must BOTH match: SS3 Science and SS2 Science are different
 * groups, and so are JSS3 and SS3 if a school ever reused a level number.
 */
export function sameStreamGroup(a: ClassNaming, b: ClassNaming): boolean {
  return (
    a.stage != null &&
    a.level != null &&
    a.stage === b.stage &&
    a.level === b.level &&
    (a.stream ?? null) === (b.stream ?? null)
  );
}
