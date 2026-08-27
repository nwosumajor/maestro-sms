// =============================================================================
// An archive that names what it holds and never what it does not
// =============================================================================
// `SchoolArchiveService` is what a school takes away for its own retention — the
// answer to "can we keep our record if we leave". Its manifest declares
// `scopedSections`, `snapshotSections`, `truncatedSections` and `sectionCounts`:
// four careful statements about what IS in the file, and nothing about what is
// not.
//
// Measured live on the demo tenant: ten sections with counts (students 901,
// attendance 173,701, auditLog 24,796 …) and no field naming an omission. A
// school opening this in ten years cannot tell whether a missing emergency
// contact means the child had none or means the archive never carried them —
// the exact ambiguity the student export bundle's `coverage` manifest was built
// to remove, one level down.
//
// // THE MEDICAL ONE IS THE LOAD-BEARING DECISION. `medical_record` is
// field-encrypted per tenant and its columns are NOT `Enc`-suffixed, so the
// archive's decryption pass — which keys on that suffix and runs only over staff
// — would not have reached them even if the section existed. Adding it would
// have carried a child's allergies as unreadable ciphertext while looking
// complete. Widening what leaves the building for minors' medical data is a
// Golden Rule #5 decision and is deliberately NOT taken here; saying so is.
// =============================================================================

import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(__dirname, "../../src/privacy/archive.service.ts"), "utf8");

/** The manifest's own declaration, read out of the source it is declared in. */
function excluded(): Array<{ section: string; reason: string }> {
  const block = SRC.slice(SRC.indexOf("const EXCLUDED_SECTIONS"), SRC.indexOf("@Injectable()"));
  return [...block.matchAll(/section:\s*"([^"]+)",\s*reason:\s*([\s\S]*?),\s*\n\s*\}/g)].map((m) => ({
    section: m[1],
    reason: m[2],
  }));
}

describe("an archive says what it leaves out", () => {
  it("declares the omissions in the manifest at all", () => {
    expect(SRC).toContain("excludedSections: EXCLUDED_SECTIONS");
    expect(excluded().length).toBeGreaterThanOrEqual(4);
  });

  it("names the categories a school would actually go looking for", () => {
    const names = excluded().map((e) => e.section);
    // Each of these is data a school holds about a pupil and would expect in
    // "all our data" — and none of them is in the archive.
    expect(names).toEqual(expect.arrayContaining(["medicalRecords", "emergencyContacts", "guardians"]));
  });

  it("gives every omission a reason that tells the reader where to go instead", () => {
    // "not included" alone reproduces the ambiguity: the point is that somebody
    // in ten years has a next step.
    for (const e of excluded()) {
      expect(e.reason.length).toBeGreaterThan(40);
      expect(e.reason).toMatch(/Ask|Download|export bundle|Vault/i);
    }
  });

  it("does not claim to exclude something it in fact carries", () => {
    // An exclusion for a section that IS archived would be worse than none —
    // it would send a reader away from data they already have.
    const carried = ["students", "studentProfiles", "enrollments", "attendance",
      "subjectResults", "invoices", "workflowRequests", "auditLog", "staff", "payrollRuns"];
    for (const e of excluded()) expect(carried).not.toContain(e.section);
  });

  it("keeps the four statements about what IS in it", () => {
    // The omissions are an addition, not a replacement: a reader needs both
    // halves to judge completeness.
    for (const field of ["scopedSections", "snapshotSections", "truncatedSections", "sectionCounts"]) {
      expect(SRC).toContain(`${field}:`);
    }
  });
});
