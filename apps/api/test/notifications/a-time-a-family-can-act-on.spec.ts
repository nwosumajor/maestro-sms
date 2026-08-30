/**
 * A NOTICE THAT NAMES A TIME NAMES THE SCHOOL'S TIME.
 *
 * `toISOString()` is the SERVER's UTC — in a container, always UTC — so every
 * notice that rendered an instant that way told a reader the wrong clock. This
 * repo has recorded the class thirteen times for DAYS; these are the TIMES:
 *
 *   meeting called      an audience-wide announcement (chunked, up to a school)
 *   co-host added       rendered TWICE in one call, so the pair could disagree
 *   meeting booked      fixed earlier
 *   meeting cancelled   fixed earlier
 *   exeat approved      "Expected back …", to a boarder's guardian
 *   boarder overdue     "was due back at …", to the family AND to the staff
 *                       about to go looking for the child
 *
 * The earlier fix introduced ONE helper for the pair it touched and left the
 * other four — including the two widest-reaching — in the same two files.
 *
 * The rule is narrow on purpose. It does NOT ban `toISOString()`: a filename
 * stamp, an export header, an audit value and an API timestamp are all correctly
 * UTC, and a rule wide enough to catch those would be the over-wide gate this
 * repo treats as the same failure as a blind one. It asks only about the strings
 * a PERSON is sent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkSources } from "../support/api-routes";

/** The instants a notice names. Each is a true timestamp, never a `@db.Date`. */
const NOTICE_INSTANTS = ["startsAt", "expectedReturnAt", "endsAt"];

const OFFENDER = new RegExp(
  `\\b(?:${NOTICE_INSTANTS.join("|")})\\b[^;\\n]{0,40}\\.toISOString\\(\\)`,
);

/**
 * EMPTY, AND THAT IS THE POINT.
 *
 * The first version of this gate exempted the staff HANDOVER report on the
 * reason "no school context resolved on that path". That reason was FALSE:
 * `openDuties` resolves the school's timezone on its very first line and passes
 * it in, and the two dated duties above the offending line already use it. The
 * meeting slot was simply the one true timestamp in a list of day columns.
 *
 * An exemption granted on a wrong reason is a hole with a note on it — the
 * thing this repo warns about — so it was checked rather than kept, and the
 * list is empty. A future entry must survive the same question: does this path
 * really have no school to ask?
 */
const EXEMPT: Record<string, string> = {};

describe("no notice tells a reader the server's clock", () => {
  const files = walkSources();

  it("scanned a believable number of sources", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("renders every notice instant through the school's zone", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.replace(/^.*\/src\//, "");
      if (EXEMPT[rel]) continue;
      // Comments explaining THIS fix mention the old call; a scan that reads
      // prose fails on the explanation of its own fix.
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      src.split("\n").forEach((line, i) => {
        if (OFFENDER.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("every exemption still names a file that exists", () => {
    for (const rel of Object.keys(EXEMPT)) {
      expect(() => readFileSync(join(__dirname, "..", "..", "src", rel), "utf8")).not.toThrow();
    }
  });

  it("the handover report resolves the zone it already had in hand", () => {
    // Kept as a named case because this file was briefly EXEMPTED from the rule
    // above on a reason that was not true.
    const src = readFileSync(join(__dirname, "..", "..", "src", "hr", "staff-handover.service.ts"), "utf8");
    expect(src).toContain("schoolTimeString(timezone,");
    // …and its DAY columns deliberately stay on UTC midnight, which is what a
    // `@db.Date` means. Narrowing those would date a cover lesson a day early.
    expect(src).toContain("d.toISOString().slice(0, 10)");
  });

  it("and every exemption gives a reason", () => {
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(30);
  });

  it("the two modules that carry these notices use the shared helper", () => {
    for (const rel of ["meeting/meeting.service.ts", "hostel/hostel.service.ts", "hostel/exeat-overdue.service.ts"]) {
      const src = readFileSync(join(__dirname, "..", "..", "src", rel), "utf8");
      expect(src).toContain("schoolTimeString");
    }
  });
});
