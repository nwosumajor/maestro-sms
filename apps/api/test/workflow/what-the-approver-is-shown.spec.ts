// =============================================================================
// A request that moves money must say what it moves
// =============================================================================
// The workflow inbox renders ONE field from a request's payload — `summary`, a
// string a SERVICE wrote — and never the raw payload, deliberately: payloads
// carry ids and a future type could put anything in there.
//
// Sound rule, and for a long time only ONE of the nine producing services wrote
// one. A three-stage chain approved "Leave: Annual" with no dates and no day
// count; the hostel and transport fee runs, which post a charge onto EVERY
// boarder's and passenger's invoice, said only their scope and due date.
//
// This gate does not demand a summary everywhere — a student exit carries the
// pupil's name in its title and reads fine. It demands one from any producer
// whose approval MOVES MONEY or grants time off, and names the rest.
// =============================================================================

import { readFileSync } from "fs";
import { join } from "path";
import { walkSources } from "../support/api-routes";

const SRC = join(__dirname, "../../src");

/** Producers whose approval bills a family, pays somebody, or grants leave. */
const MUST_SUMMARISE = [
  "src/hr/leave.service.ts",
  "src/hostel/hostel.service.ts",
  "src/transport/transport.service.ts",
];

/**
 * Producers that carry the deciding facts in their TITLE instead, with what the
 * title actually says — so a reader can judge whether that is still enough.
 */
const TITLE_IS_ENOUGH: Record<string, string> = {
  "src/lms/student-exit.service.ts": "Student exit — <pupil name> (<kind>)",
  "src/attendance/attendance.service.ts": "Attendance amendment — <date>",
  "src/admin/admin.service.ts": "the appointment names the user and the role",
  "src/gradebook/term-result.service.ts": "writes its own summary already",
  "src/cbt/cbt.service.ts": "the exam's own title",
  "src/exam/exam.service.ts": "the sitting's own title",
  "src/lms/lms-content.service.ts": "Publish: <the content's own title>",
  "src/workflow/workflow.controller.ts":
    "the GENERIC create route — the caller supplies title and payload, so there " +
    "is no service here to write a summary. STAFF_REQUEST comes through it and " +
    "carries {category, details}; if a money-moving type is ever added to " +
    "WORKFLOW_TYPE_META it needs a producer of its own, not this route.",
};

describe("what the approver is shown", () => {
  const files = walkSources(SRC);

  it("scanned a believable number of sources", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("every producer is either summarised or named as title-only", () => {
    const producers = files
      .filter((f) => /workflow\.createRequest\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(SRC, "src"));
    // If this finds nothing the gate is watching nothing.
    expect(producers.length).toBeGreaterThanOrEqual(6);
    const unaccounted = producers.filter(
      (f) => !MUST_SUMMARISE.includes(f) && !TITLE_IS_ENOUGH[f],
    );
    expect(unaccounted).toEqual([]);
  });

  it("a money-moving request actually writes a summary into its payload", () => {
    const missing = MUST_SUMMARISE.filter((rel) => {
      const src = readFileSync(join(SRC, rel.replace(/^src\//, "")), "utf8");
      // The payload literal must carry it — a summary computed and not passed
      // is the same blank inbox.
      return !/payload:\s*\{[\s\S]{0,600}?summary/.test(src);
    });
    expect(missing).toEqual([]);
  });

  it("names only files that still produce requests", () => {
    // A dangling entry is a hole waiting for the name to be reused.
    for (const rel of [...MUST_SUMMARISE, ...Object.keys(TITLE_IS_ENOUGH)]) {
      const src = readFileSync(join(SRC, rel.replace(/^src\//, "")), "utf8");
      expect(src).toContain("createRequest(");
    }
  });
});
