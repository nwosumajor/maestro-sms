// =============================================================================
// Why a pupil left, which the school recorded and never saw again
// =============================================================================
// The exit captures both: the KIND onto every enrolment's status
// (TRANSFERRED / WITHDRAWN / GRADUATED), and the free-text note onto
// `statusReason`. Neither was read back anywhere — not in the API, not in the
// web.
//
// So a leavers register could say who left and when, and not whether they
// graduated or were withdrawn. That is the first question anybody asks of such a
// list, and the school had already answered it when it approved the exit.
//
// FOUND BY SWEEP, not by reading the module. A search for columns that are
// WRITTEN and never READ turned up 29 candidates; `statusReason` was the only
// true one. The rest were provenance columns that are correct to write and never
// query (`issuedById`, `finalizedById`, `closedById`), or false positives where
// the read was there and my pattern missed it:
//
//   * `lastNudgedAt` IS read — inside a nested OR, which is exactly what makes
//     the daily nudge idempotent;
//   * `paidOutAt`, `formFeeRef`, `disbursementPaymentId` ride along in rows
//     returned by a findMany with no select.
//
// A sweep that is not checked case by case produces confident nonsense.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/lms/student-exit.service.ts"), "utf8");
const LIST = SRC.slice(SRC.indexOf("async listExited"));

describe("the leavers register says why", () => {
  it("reads the kind and the note back", () => {
    expect(LIST).toMatch(/statusReason: true/);
    expect(LIST).toMatch(/exitKind:/);
    expect(LIST).toMatch(/exitReason:/);
  });

  it("asks only for enrolments that are CLOSED", () => {
    // An ACTIVE enrolment has no exit reason on it, and including one would
    // read a live pupil's row as though it recorded a departure.
    expect(LIST).toMatch(/status: \{ not: "ACTIVE" \}/);
  });

  it("takes the most recent, because the exit closes them together", () => {
    expect(LIST).toMatch(/orderBy: \{ enrolledAt: "desc" \}/);
    expect(LIST).toMatch(/if \(!reasonOf\.has\(e\.studentId\)\)/);
  });

  it("is ONE query for the page, not one per leaver", () => {
    // A leavers list only grows. Per-row lookups are the shape that turns a
    // fast page slow three years in — the same reason the balances above it are
    // grouped.
    expect(LIST).toMatch(/studentId: \{ in: ids \}/);
    expect(LIST).not.toMatch(/rows\.map\([\s\S]{0,120}?await tx\.enrollment/);
  });

  it("says nothing rather than guessing when there is no record", () => {
    // A leaver imported before the exit workflow existed has no closed
    // enrolment. "—" is honest; inventing "withdrawn" would not be.
    expect(LIST).toMatch(/exitKind: reasonOf\.get\(r\.id\)\?\.kind \?\? null/);
    expect(LIST).toMatch(/exitReason: reasonOf\.get\(r\.id\)\?\.reason \?\? null/);
  });
});

describe("the exit still records it", () => {
  it("writes the kind and the reason onto every enrolment it closes", () => {
    const apply = SRC.slice(SRC.indexOf("private async applyExit"), SRC.indexOf("async readmit"));
    expect(apply).toMatch(/data: \{ status: kind, statusReason: reason \?\? null \}/);
  });
});
