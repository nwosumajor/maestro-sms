/**
 * A document that has expired no longer satisfies its requirement.
 *
 * A requirement can be marked `needsExpiry`, and a verifier records the date it
 * runs out. NOTHING looked at that date: `outstandingRequirements` decided on
 * `status` alone, so an immunisation record that lapsed two years ago went on
 * ticking its requirement off for ever, and the checklist a registrar reads said
 * the school held a valid one.
 *
 * Same shape as the ERASED status one layer over in this module — a document the
 * school no longer has, still counted as held — and the same rule the STAFF
 * document sweep already applies: a certificate is valid THROUGH the day it
 * names, against the SCHOOL's day rather than the server's.
 *
 * `asAt` is REQUIRED rather than defaulted, which is what found all eleven call
 * sites across the API and its tests.
 */
import { isExpired, outstandingRequirements, submissionProgress } from "@sms/types";

const TODAY = new Date("2026-08-29T00:00:00.000Z");
const req = (key: string, extra: Record<string, unknown> = {}) => ({
  id: key, key, label: key, mandatory: true, active: true, ...extra,
});
const sub = (key: string, status: string, expiresAt: string | null = null) =>
  ({ requirementId: key, status: status as never, expiresAt: expiresAt ? new Date(expiresAt) : null });

describe("a document that expired is not held", () => {
  it("stops satisfying its requirement once the date has passed", () => {
    const out = outstandingRequirements([req("immunisation")], [sub("immunisation", "VERIFIED", "2024-06-01")], TODAY);
    expect(out.map((r) => r.key)).toEqual(["immunisation"]);
  });

  it("still satisfies while it is in date", () => {
    const out = outstandingRequirements([req("immunisation")], [sub("immunisation", "VERIFIED", "2027-01-01")], TODAY);
    expect(out).toEqual([]);
  });

  it("is valid THROUGH the day it names, never up to it", () => {
    // The staff sweep settled this: a certificate expiring today is good today.
    // `<=` here would fail a document on its own last valid day.
    expect(isExpired({ expiresAt: TODAY }, TODAY)).toBe(false);
    expect(isExpired({ expiresAt: new Date("2026-08-28T00:00:00.000Z") }, TODAY)).toBe(true);
  });

  it("leaves a document with no expiry alone", () => {
    // Most requirements never expire — a birth certificate does not — and they
    // must not start falling off the list.
    expect(isExpired({ expiresAt: null }, TODAY)).toBe(false);
    expect(outstandingRequirements([req("birth")], [sub("birth", "VERIFIED")], TODAY)).toEqual([]);
  });

  it("ignores an unparseable date rather than failing the document", () => {
    // Refusing to count a document because its date is malformed would chase a
    // family for something the school already holds.
    expect(isExpired({ expiresAt: "not a date" }, TODAY)).toBe(false);
  });

  it("counts an expired document as missing in the progress summary", () => {
    const p = submissionProgress([req("immunisation")], [sub("immunisation", "VERIFIED", "2024-06-01")], TODAY);
    expect(p.complete).toBe(false);
    expect(p.missingMandatory).toBe(1);
  });

  it("does not resurrect a REJECTED document just because it has no expiry", () => {
    // The status rule still runs first.
    expect(
      outstandingRequirements([req("photo")], [sub("photo", "REJECTED")], TODAY).map((r) => r.key),
    ).toEqual(["photo"]);
  });
});
