// =============================================================================
// A typo in a query string became a 500 and a Sentry event
// =============================================================================
// `page ? Number(page) : 1` has three failure modes and all of them reached the
// database:
//
//   ?page=abc     -> NaN      -> skip: NaN      -> PrismaClientValidationError
//   ?page=1e999   -> Infinity -> skip: Infinity -> the same
//   ?pageSize=1e9 -> a take nobody meant
//
// Measured live: `?page=abc` on /students/exited, /operator/tenants and
// /operator/payments each returned 500 Internal server error and — through the
// observability spine — raised a Sentry event. A query-string typo on the
// platform owner's own console became an error-tracking alert with a stack
// trace, where the caller needed one sentence telling them what to type.
//
// /notifications was the interesting near-miss: it guarded with
// `Number.isFinite`, so it never 500'd — and SILENTLY served page 1 instead, to
// somebody paging through their inbox.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { pageNumber } from "../../src/common/status-filter";

describe("reading a page number off a query string", () => {
  it("takes a whole number", () => {
    expect(pageNumber("3")).toBe(3);
  });

  it("REFUSES letters rather than handing NaN to the database", () => {
    expect(() => pageNumber("abc")).toThrow(BadRequestException);
  });

  it("refuses an exponent that overflows into Infinity", () => {
    expect(() => pageNumber("1e999")).toThrow(BadRequestException);
  });

  it("refuses zero and negatives — there is no page 0", () => {
    expect(() => pageNumber("0")).toThrow(BadRequestException);
    expect(() => pageNumber("-5")).toThrow(BadRequestException);
  });

  it("refuses a fraction, which would skip a fraction of a row", () => {
    expect(() => pageNumber("2.5")).toThrow(BadRequestException);
  });

  it("refuses a page size nobody meant, rather than trying to serve it", () => {
    expect(() => pageNumber("100000000", "pageSize")).toThrow(/pageSize must be/);
  });

  it("says what a correct value looks like", () => {
    // "invalid page" sends somebody to read the source.
    expect(() => pageNumber("abc")).toThrow("page must be a whole number between 1 and 1000000");
  });

  it("treats ABSENT and EMPTY as no answer, so the handler's default applies", () => {
    // A caller who did not ask for a page must still get the first one, not a
    // 400 — that is how a validation fix becomes a broken screen.
    expect(pageNumber(undefined)).toBeUndefined();
    expect(pageNumber(null)).toBeUndefined();
    expect(pageNumber("")).toBeUndefined();
    expect(pageNumber("  ")).toBeUndefined();
  });
});
