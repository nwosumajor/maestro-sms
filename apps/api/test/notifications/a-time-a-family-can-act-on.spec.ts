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
 * Named, with the reason — not a blanket pass.
 *
 * The staff HANDOVER report is a STAFF-facing list of a leaver's duties across
 * every module, built without a school context to resolve a zone from; it is
 * read beside other UTC stamps in the same artifact. Recorded here rather than
 * fixed silently, so it is a decision somebody can revisit.
 */
const EXEMPT: Record<string, string> = {
  "hr/staff-handover.service.ts":
    "a staff-facing duty list, not a notice to a family; no school context resolved on that path",
};

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
