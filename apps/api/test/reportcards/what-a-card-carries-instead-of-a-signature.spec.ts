// =============================================================================
// The attestation a report card carries instead of a signature
// =============================================================================
// This platform captures no signature — no image, no certificate, nothing in
// SchoolBranding but a logo and three brand-colour numbers. A printed card has a
// ruled line signed by hand, and the VAULT copy a guardian downloads carried
// that line permanently blank: the digital card was the one nobody had signed.
//
// These are the properties that make the replacement worth having. Each is
// asserted against the pure helpers or the rendered PDF, never against a
// screenshot of the source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attestationContentHash,
  formatAttestationCode,
  generateAttestationCode,
  normaliseAttestationCode,
} from "../../src/reportcards/report-card-attestation.service";
import { stripComments } from "../support/strip-comments";

describe("the verification code", () => {
  it("is 12 characters from an alphabet with no I, L, O or U", () => {
    // Read off a printed page and typed by hand, so 1/I and 0/O cannot be
    // confused — and a random 12-char run cannot spell anything unfortunate.
    for (let i = 0; i < 200; i += 1) {
      const code = generateAttestationCode();
      expect(code).toHaveLength(12);
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    }
  });

  it("does not repeat", () => {
    // 60 bits. The guard against guessing is the entropy, not the rate limit.
    const seen = new Set(Array.from({ length: 2000 }, () => generateAttestationCode()));
    expect(seen.size).toBe(2000);
  });

  it("round-trips through the grouped form a person reads aloud", () => {
    const code = "ABCD1234EFGH";
    expect(formatAttestationCode(code)).toBe("ABCD-1234-EFGH");
    expect(normaliseAttestationCode("abcd-1234-efgh")).toBe(code);
    expect(normaliseAttestationCode(" ABCD 1234 EFGH ")).toBe(code);
  });
});

describe("the content hash, which decides what counts as a new issue", () => {
  const base = {
    approvedById: "u1",
    termAverage: 57.78,
    termGrade: "C5",
    subjects: [
      { subject: "Mathematics", total: 75, grade: "A1" },
      { subject: "English", total: 65, grade: "B3" },
    ],
  };

  it("is stable when nothing about the document has moved", () => {
    // Printing the same card twice must not tell every holder theirs was
    // superseded.
    expect(attestationContentHash(base)).toBe(attestationContentHash({ ...base }));
  });

  it("ignores the order the subjects arrive in", () => {
    // Row order is not part of the document, and a query's ordering is not a
    // reason to reissue.
    const reversed = { ...base, subjects: [...base.subjects].reverse() };
    expect(attestationContentHash(reversed)).toBe(attestationContentHash(base));
  });

  it("moves when a single mark changes", () => {
    const doctored = {
      ...base,
      subjects: [{ subject: "Mathematics", total: 95, grade: "A1" }, base.subjects[1]],
    };
    expect(attestationContentHash(doctored)).not.toBe(attestationContentHash(base));
  });

  it("moves when the GRADE changes but the total does not", () => {
    // A scale change re-letters a mark without moving it. That is a different
    // document to anyone reading the letter.
    const relettered = {
      ...base,
      subjects: [{ subject: "Mathematics", total: 75, grade: "A" }, base.subjects[1]],
    };
    expect(attestationContentHash(relettered)).not.toBe(attestationContentHash(base));
  });

  it("moves when a different person signs it", () => {
    expect(attestationContentHash({ ...base, approvedById: "u2" })).not.toBe(attestationContentHash(base));
  });

  it("moves when the overall average changes", () => {
    expect(attestationContentHash({ ...base, termAverage: 60 })).not.toBe(attestationContentHash(base));
  });
});

describe("the public verification route", () => {
  const src = stripComments(
    readFileSync(join(__dirname, "../../src/reportcards/report-card-attestation.service.ts"), "utf8"),
  );

  it("found the source it is about", () => {
    expect(src.length).toBeGreaterThan(4000);
  });

  it("resolves the school FIRST and then reads under that school's RLS", () => {
    // NOT a privileged client. An internet-facing route must not have more reach
    // than the app role (Golden Rule #4), and carrying the slug in the URL is
    // what makes a tenant-scoped read possible for a caller with no tenant.
    const verify = src.slice(src.indexOf("async verify("));
    expect(verify).toMatch(/tx\.school\.findFirst\(\{ where: \{ slug/);
    expect(verify).toMatch(/runAsTenant\(\{ schoolId: school\.id/);
    expect(verify).not.toMatch(/RETENTION_URL|MIGRATE_URL|privileged/i);
  });

  it("answers 404 for an unknown school and an unknown code alike", () => {
    // A verifier who mistypes must not learn which half they got right.
    const verify = src.slice(src.indexOf("async verify("));
    const misses = [...verify.matchAll(/throw new NotFoundException\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(misses.length).toBeGreaterThanOrEqual(3);
    expect(new Set(misses).size).toBe(1);
  });

  it("audits the read, because it returns a minor's academic record", () => {
    // Golden Rule #5. The actor is the system: the caller is unauthenticated by
    // design and inventing an identity would make the trail say something untrue.
    const verify = src.slice(src.indexOf("async verify("));
    expect(verify).toMatch(/audit[\s\S]{0,80}record\(/);
    expect(verify).toMatch(/actorId: SYSTEM_ACTOR_ID/);
  });
});
