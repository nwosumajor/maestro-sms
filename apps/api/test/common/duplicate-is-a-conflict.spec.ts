// =============================================================================
// Every duplicate a user could create was an "Internal server error"
// =============================================================================
// `MalformedIdFilter` is `@Catch(Prisma.PrismaClientKnownRequestError)` but only
// translated malformed UUIDs; everything else fell through to a 500. So a
// UNIQUE constraint violation — the most ordinary mistake a user makes — was an
// internal error. Confirmed live, and NOT as a race:
//
//     POST /hr/leave/types {"name":"Study Leave Probe"}   201
//     POST /hr/leave/types {"name":"Study Leave Probe"}   500
//
// An HR manager adding a leave type that already exists is told the server
// broke. A sweep of creates on uniquely-constrained models found EIGHT with no
// duplicate check and no catch: leave types, an invoice REFERENCE the caller
// supplies, a second current academic session, a biometric device, an
// invigilator assigned twice, an agent code. Two more were fixed one at a time
// earlier this session — the poll vote (#252) and starting a CBT sitting (#257)
// — which is what suggested the translation belongs in one place rather than
// nine.
//
// It does not replace a per-site check: the library's "A book with that barcode
// already exists" still runs first and still reads better. This is the floor.
// =============================================================================

import { Prisma } from "@sms/db";
import { stripComments } from "../support/strip-comments";
import { duplicateMessage } from "../../src/common/malformed-id.filter";

/** A P2002 shaped exactly like the one the running system produced. */
function uniqueViolation(model: string): Prisma.PrismaClientKnownRequestError {
  const e = new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`prisma.${model}.create()\` invocation:\n\n\nUnique constraint failed on the (not available)`,
    { code: "P2002", clientVersion: "5" },
  );
  return e;
}

describe("the message a duplicate produces", () => {
  it("names the thing, humanised from the model", () => {
    expect(duplicateMessage(uniqueViolation("leaveType"))).toBe(
      "A leave type with those details already exists.",
    );
  });

  it("handles a single-word model", () => {
    expect(duplicateMessage(uniqueViolation("invoice"))).toBe(
      "An invoice with those details already exists.".replace("An", "A"),
    );
  });

  it("handles a three-word model", () => {
    expect(duplicateMessage(uniqueViolation("classSubjectTeacher"))).toBe(
      "A class subject teacher with those details already exists.",
    );
  });

  it("stays honest when the model cannot be read", () => {
    // Prisma does NOT populate meta.target here — the raw error says
    // "failed on the (not available)" — so there is no field to quote. When
    // even the model is missing, say less rather than invent.
    const e = new Prisma.PrismaClientKnownRequestError("something else entirely", {
      code: "P2002",
      clientVersion: "5",
    });
    expect(duplicateMessage(e)).toBe("That already exists.");
  });

  it("never quotes a field name", () => {
    // The trap a previous translator in this codebase fell into: keying off a
    // `meta` field Prisma never populates, so it silently never fired.
    for (const m of ["leaveType", "invoice", "examInvigilator"]) {
      expect(duplicateMessage(uniqueViolation(m))).not.toMatch(/undefined|not available|null/);
    }
  });
});

describe("the filter's shape", () => {
  const SRC = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/common/malformed-id.filter.ts"),
    "utf8",
  ) as string;
  const code = stripComments(SRC);

  it("answers 409, not 404 or 400", () => {
    // A duplicate is not "not found", and it is not the caller sending
    // something malformed — the request was well-formed and lost a race with
    // reality.
    expect(code).toMatch(/ConflictException\(duplicateMessage\(exception\)\)/);
  });

  it("still 404s a malformed id", () => {
    expect(code).toMatch(/isMalformedUuidError/);
    expect(code).toMatch(/NotFoundException\("Not found"\)/);
  });

  it("still lets everything else be a 500", () => {
    // A genuine P2023 from corrupt data must stay loud.
    expect(code).toMatch(/super\.catch\(exception, host\)/);
  });

  it("logs a duplicate at WARN, not debug", () => {
    // It means no call site checked. Worth seeing when deciding where a
    // per-site message would read better than the generic one.
    expect(code).toMatch(/logger\.warn\(`duplicate on/);
  });

  it("leaves non-HTTP contexts alone", () => {
    // A duplicate inside a BullMQ job is a real bug; turning it into a 409
    // nobody receives would strand the job with no signal.
    expect(code).toMatch(/isMalformedIdCandidate\(host\)/);
  });
});
