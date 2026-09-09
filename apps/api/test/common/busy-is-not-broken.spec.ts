// =============================================================================
// A full connection pool is BUSY, not BROKEN
// =============================================================================
// Every tenant-scoped read opens a transaction, because `runAsTenant` has to set
// the RLS GUC. When the pool is full, Prisma reports P2028 ("Unable to start a
// transaction in the given time") — or P2024 for a plain query — and both fell
// through to a 500 "Internal server error".
//
// That message is wrong on three counts: nothing is broken, it names no way out,
// and it sends a principal to support for a condition that clears itself in
// seconds. Measured on a 1,500-school fleet: one large school's analytics
// overview takes ~250 ms, and thirty at once against Prisma's default pool
// (cpus x 2 + 1 = 17 on the test host) failed 24 of 40 requests as 500s. After:
// 25 succeed and 15 answer 503 with Retry-After.
//
// The work was never attempted, so nothing was changed and a retry is the right
// advice — which is exactly what a 503 with Retry-After says, to a person and to
// a proxy.
// =============================================================================

import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { MalformedIdFilter } from "../../src/common/malformed-id.filter";

function prismaError(code: string, message: string) {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "5.22.0" });
}

/** An ArgumentsHost for an HTTP request, with the response headers captured. */
function httpHost(url = "/analytics/overview") {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => { headers[k] = v; } };
  const req = { method: "GET", url };
  return {
    headers,
    host: {
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as never,
  };
}

/** Captures what the filter ultimately hands to Nest's base filter. */
function filterCatching() {
  const seen: unknown[] = [];
  const f = new MalformedIdFilter();
  // The base filter would write a real HTTP response; we only need what it was
  // asked to render.
  (f as unknown as { catch: unknown });
  Object.setPrototypeOf(f, MalformedIdFilter.prototype);
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(f));
  jest.spyOn(proto, "catch").mockImplementation(function (this: unknown, e: unknown) { seen.push(e); });
  return { f, seen };
}

describe("a full connection pool", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ["P2028", "Transaction API error: Unable to start a transaction in the given time."],
    ["P2024", "Timed out fetching a new connection from the connection pool."],
  ])("answers 503, not 500 (%s)", (code, message) => {
    const { f, seen } = filterCatching();
    const { host } = httpHost();
    f.catch(prismaError(code, message), host);
    expect(seen[0]).toBeInstanceOf(ServiceUnavailableException);
  });

  it("tells the caller nothing was changed and to try again", () => {
    const { f, seen } = filterCatching();
    f.catch(prismaError("P2028", "Unable to start a transaction in the given time."), httpHost().host);
    const said = String((seen[0] as ServiceUnavailableException).message);
    // Anchored to the PROPERTIES a refusal must carry, not to the wording.
    expect(said).toMatch(/busy/i);
    expect(said).toMatch(/nothing was changed/i);
    expect(said).toMatch(/try again/i);
    // And it must not claim a fault.
    expect(said).not.toMatch(/internal server error/i);
  });

  it("sets Retry-After, so a proxy or client retries without being told twice", () => {
    const { f, seen } = filterCatching();
    const h = httpHost();
    f.catch(prismaError("P2028", "Unable to start a transaction in the given time."), h.host);
    expect(seen).toHaveLength(1);
    expect(Number(h.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("leaves the OTHER Prisma translations alone", () => {
    // A duplicate is still a 409 and a malformed uuid still a 404 — this filter
    // gained a branch, it did not take over.
    const dup = filterCatching();
    dup.f.catch(prismaError("P2002", "Unique constraint failed on prisma.leaveType.create()"), httpHost().host);
    expect(dup.seen[0]).toBeInstanceOf(ConflictException);

    const bad = filterCatching();
    bad.f.catch(prismaError("P2023", "Error creating UUID, invalid character"), httpHost().host);
    expect(bad.seen[0]).toBeInstanceOf(NotFoundException);
  });

  it("a genuine fault is STILL a loud 500 — busy must not become a blanket excuse", () => {
    const { f, seen } = filterCatching();
    // P2021 — the table does not exist. Unambiguously a fault of ours, and
    // nothing a caller can act on, so it must reach Nest untranslated.
    //
    // This used to be P2003, chosen as a stand-in for "some other error" rather
    // than as a ruling that a foreign-key violation belongs in a 500. It does
    // not: see the case below.
    const boom = prismaError("P2021", "The table `document` does not exist in the current database.");
    f.catch(boom, httpHost().host);
    // Passed through untouched, so Nest renders it as the 500 it is.
    expect(seen[0]).toBe(boom);
  });

  it("an id that names NOTHING is the caller's mistake, and says which id", () => {
    // The other half of "an id arrived in the request body", and the same
    // argument as the duplicate above. Found on POST /documents: a studentId
    // that is nobody reached document.create unchecked, Postgres refused the
    // foreign key, and the principal was told "Internal server error" — untrue,
    // no way out, and it sends them to support rather than to the id they
    // mistyped.
    const { f, seen } = filterCatching();
    const e = prismaError("P2003", "Foreign key constraint violated");
    (e as unknown as { meta: unknown }).meta = { field_name: "document_studentId_fkey (index)" };
    f.catch(e, httpHost().host);
    expect(seen[0]).toBeInstanceOf(BadRequestException);
    // NAMES THE FIELD. P2003 carries one in meta.field_name, unlike P2002 —
    // "That student does not exist" is actionable where "Bad Request" is not.
    expect((seen[0] as BadRequestException).message).toBe("That student does not exist.");
  });

  it("...and still says something useful when Prisma names no field", () => {
    const { f, seen } = filterCatching();
    f.catch(prismaError("P2003", "Foreign key constraint violated"), httpHost().host);
    expect(seen[0]).toBeInstanceOf(BadRequestException);
    expect((seen[0] as BadRequestException).message).toBe("Something you referenced does not exist.");
  });
});
