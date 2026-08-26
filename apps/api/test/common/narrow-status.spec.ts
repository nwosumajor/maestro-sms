// =============================================================================
// What an unrecognised filter value must mean
// =============================================================================
// Not "everything", and not "nothing". Both are confident false statements about
// a question the system did not understand, and this platform made both:
//
//   GET /invoices?status=OVERDUE   dropped it -> all 14 invoices, "filtered"
//   GET /library/loans?status=OUT  used it    -> 26 loans became 0
//   GET /hostels/exeats?status=…   used it    -> one overdue boarder became none
//
// The last matters most: a page reporting that no boarder is signed out is a
// safety statement about children, made by a typo.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { narrowStatus } from "../../src/common/status-filter";

const LOANS = ["ISSUED", "RETURNED"] as const;

describe("narrowing a caller's status", () => {
  it("passes a value it recognises straight through", () => {
    expect(narrowStatus("ISSUED", LOANS)).toBe("ISSUED");
  });

  it("REFUSES one it does not, rather than guessing either way", () => {
    expect(() => narrowStatus("OUT", LOANS)).toThrow(BadRequestException);
  });

  it("names the allowed values, so the caller can correct it", () => {
    // "invalid status" sends somebody to read the source.
    expect(() => narrowStatus("OUT", LOANS)).toThrow("status must be one of ISSUED, RETURNED");
  });

  it("uses the field's own name when it is not called status", () => {
    // The operator directory narrows `plan` and `billing` the same way.
    expect(() => narrowStatus("GOLD", ["STANDARD"] as const, "plan")).toThrow("plan must be one of STANDARD");
  });

  it("treats ABSENT as no filter — the whole list, which is what was asked for", () => {
    expect(narrowStatus(undefined, LOANS)).toBeUndefined();
    expect(narrowStatus(null, LOANS)).toBeUndefined();
  });

  it("treats an EMPTY string as no filter too — a cleared dropdown submits one", () => {
    // Refusing this would break the ordinary "show me everything" case, which
    // is how a validation fix becomes a broken screen.
    expect(narrowStatus("", LOANS)).toBeUndefined();
    expect(narrowStatus("   ", LOANS)).toBeUndefined();
  });

  it("is exact — no case folding a value into existence", () => {
    // `issued` is not `ISSUED`. Accepting it would mean the set is not the set,
    // and the next filter to compare against it would disagree.
    expect(() => narrowStatus("issued", LOANS)).toThrow(BadRequestException);
    // Surrounding whitespace from a query string is not the caller's error.
    expect(narrowStatus(" ISSUED ", LOANS)).toBe("ISSUED");
  });
});
