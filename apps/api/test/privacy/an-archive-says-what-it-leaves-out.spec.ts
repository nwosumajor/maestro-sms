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

const SCOPED = (): string[] => {
  const m = /scopedSections: window\s*\?\s*\[([\s\S]*?)\]/.exec(SRC);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
};
const SNAPSHOT = (): string[] => {
  const m = /snapshotSections: \[([\s\S]*?)\]/.exec(SRC);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
};

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
      // A reason must tell the reader where to go instead. Usually that is
      // OUTSIDE the file — the data controller, the Document Vault, a pupil's
      // own NDPR bundle. It can also be a section this archive DOES carry, and
      // that is the better answer where it applies: "the results are in
      // `subjectResults`" is more use to a reader in ten years than "ask the
      // school", and pretending otherwise would push a worse sentence into the
      // artifact to satisfy a test.
      expect(e.reason).toMatch(/Ask|Download|export bundle|Vault|are (in|carried)/i);
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

// =============================================================================
// An archive you can actually READ
// =============================================================================
// Every row the archive carries is keyed on opaque UUIDs. A `subject_result`
// names a `classId`, a `subjectId`, a `termId` and a `sessionId`, and not one of
// them resolved to anything inside the file — so the school's academic record,
// the thing it most needs to keep, was a table of scores against identifiers
// with no lookup. You could not tell Mathematics from History.
//
// The lookups are REFERENCE data, bounded by the school's structure rather than
// its lifetime, and tiny beside what they explain: 11 subjects, 31 classes,
// 2 sessions and 4 terms against 24,302 results in the demo school.
//
// This is not "carry every table". It is: whatever the archive DOES carry must
// be readable without a database nobody has any more.
// =============================================================================

describe("an archive you can actually read", () => {
  const carried = () => new Set([...SCOPED(), ...SNAPSHOT()]);

  it("carries a lookup for every kind of id its rows are keyed on", () => {
    // Each foreign key that appears in the carried rows, and the section that
    // resolves it. `studentId` was always resolvable; the other four were not.
    const RESOLVERS: Record<string, string> = {
      studentId: "students",
      subjectId: "subjects",
      classId: "classes",
      sessionId: "academicSessions",
      termId: "terms",
    };
    const missing = Object.entries(RESOLVERS)
      .filter(([, section]) => !carried().has(section))
      .map(([key, section]) => `${key} -> ${section}`);
    expect(missing).toEqual([]);
  });

  it("carries the register header, so a day of attendance has a class", () => {
    // `attendance_record` carries a denormalised `date`, so the DAY already
    // resolves. Without the session the CLASS does not.
    expect(carried().has("attendanceSessions")).toBe(true);
  });

  it("found the section lists at all", () => {
    expect(carried().size).toBeGreaterThan(8);
  });
});
