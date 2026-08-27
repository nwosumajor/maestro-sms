// =============================================================================
// A malformed id in the path is "not found", not a crash
// =============================================================================
// `GET /timetable/periods/undefined` returned 500 across every `:id` route in
// the API. The narrow-scoping test is the important one: P2023 also covers
// genuine data corruption, and turning THAT into a quiet 404 would hide a real
// fault behind a shrug — the exact silent-success failure this codebase keeps
// finding.
// =============================================================================

import { Prisma } from "@sms/db";
import { isMalformedUuidError } from "../../src/common/malformed-id.filter";

const known = (code: string, meta?: Record<string, unknown>, message = "boom") =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "x", meta });

describe("recognising a malformed id", () => {
  it("matches what the running database actually sends", () => {
    // Captured from the live API, not invented: code P2023 with the parse
    // failure in meta.message. The previous error translator in this codebase
    // keyed off a meta field Prisma never populates and silently never fired,
    // so this fixture is copied from real output.
    const e = known("P2023", {
      modelName: "Period",
      message:
        "Error creating UUID, invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `u` at 1",
    });
    expect(isMalformedUuidError(e)).toBe(true);
  });

  it("matches when the detail is only on the top-level message", () => {
    expect(isMalformedUuidError(known("P2023", undefined, "Inconsistent column data: Error creating UUID, bad"))).toBe(true);
  });
});

describe("a raw statement that casts the id itself", () => {
  it("matches the P2010/22P02 shape the database actually sends", () => {
    // Captured from the live API, not invented. `POST /invoices/:id/payments`
    // locks the invoice FOR UPDATE before its findFirst — deliberately, so two
    // recorders cannot both pass the overpayment check — and that raw cast
    // rejects a malformed id before Prisma's own UUID parsing ever runs. It was
    // the one write in the API still answering 500 where `issue` and `cancel`
    // on the same resource answered 404.
    expect(
      isMalformedUuidError(
        known("P2010", undefined, 'Invalid `prisma.$executeRaw()` invocation:\n\n\nRaw query failed. Code: `22P02`. Message: `ERROR: invalid input syntax for type uuid: "undefined"`'),
      ),
    ).toBe(true);
  });

  it("leaves other 22P02s alone — a bad integer or enum is not a missing record", () => {
    // 22P02 is "invalid text representation" generally. Matching the SQLSTATE
    // rather than the TYPE NAME would turn real faults into a quiet 404, the
    // same line this filter already draws around a general P2023.
    for (const detail of [
      'Raw query failed. Code: `22P02`. Message: `ERROR: invalid input syntax for type integer: "abc"`',
      'Raw query failed. Code: `22P02`. Message: `ERROR: invalid input syntax for type json`',
    ]) {
      expect(isMalformedUuidError(known("P2010", undefined, detail))).toBe(false);
    }
  });

  it("leaves an unrelated raw failure alone", () => {
    expect(
      isMalformedUuidError(known("P2010", undefined, "Raw query failed. Code: `42P01`. Message: `ERROR: relation does not exist`")),
    ).toBe(false);
  });
});

describe("what it must NOT swallow", () => {
  it("leaves other P2023s alone — corrupt data must stay loud", () => {
    // A bad enum value in a column is also P2023. Reporting that as 404 would
    // turn real corruption into "no such record" and nobody would ever look.
    const e = known("P2023", { modelName: "Payment", message: "Value 'WEIRD' not found in enum 'PaymentKind'" });
    expect(isMalformedUuidError(e)).toBe(false);
  });

  it("leaves a unique violation alone", () => {
    expect(isMalformedUuidError(known("P2002"))).toBe(false);
  });

  it("leaves a non-Prisma error alone", () => {
    expect(isMalformedUuidError(new Error("Error creating UUID"))).toBe(false);
  });
});
