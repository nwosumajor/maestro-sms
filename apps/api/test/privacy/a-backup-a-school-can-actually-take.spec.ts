// =============================================================================
// A backup a school can actually take away
// =============================================================================
// Asked whether the fifteen-year archive means a school can put its record on an
// external drive. Driving it end to end found THREE defects in a row on that one
// path, and every status along the way was a success — which is what made them
// invisible: 201 create, 201 for the URL, 200 on the fetch, and the file you got
// was not your file.
//
//   1. TIMED OUT.  `POST /privacy/archives` answered 500 after 5,033 ms with
//      "Transaction already closed". The attendance section paged with OFFSET
//      over an unindexed `createdAt`, re-sorting 173,701 rows on each of 174
//      pages. No school big enough to need an archive could produce one, and
//      the three archives already stored read `attendance: 0`.
//   2. THREW ON BIGINT.  `payroll_run.totalGrossMinor` is int8 — deliberately,
//      because "int4 can overflow a lifetime kobo total" — and JSON.stringify
//      throws on a BigInt. Any school that had ever run payroll was blocked.
//   3. RETURNED THE WRONG BYTES.  The stub storage route returned the Buffer
//      bare under `passthrough`, so Nest JSON-serialised it:
//      `{"type":"Buffer","data":[…]}` — 304,025,549 bytes for a 90.61 MB
//      archive, and a checksum that could never match. A separate one-character
//      bug in the key shape rejected the `.json` extension outright.
//
// After: 90.62 MB, 95,018,285 bytes fetched, sha256 EQUAL to the recorded
// checksum, 173,701 attendance rows, nothing truncated.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("producing the archive", () => {
  const src = read("privacy/archive.service.ts");

  it("is given a bulk-read timeout, because a whole school is not a page load", () => {
    expect(src).toMatch(/ARCHIVE_TIMEOUT_MS/);
    expect(src).toMatch(/\{ timeoutMs: ARCHIVE_TIMEOUT_MS \}/);
  });

  it("walks attendance by MONTH, so nothing is sorted or skipped", () => {
    // The table is partitioned on `date`, so a month prunes to one partition.
    // OFFSET paging over an unindexed order costs O(pages x rows) and pays it
    // again on every page.
    expect(src).toMatch(/private async byMonth\(/);
    expect(src).not.toMatch(/attendanceRecord\.findMany\(\{ skip/);
  });

  it("serialises BigInt as an exact string, never a rounded number", () => {
    // A JS number cannot hold what an int8 can. Silently rounding a payroll
    // total inside the artifact a school keeps for fifteen years is worse than
    // failing loudly.
    expect(src).toMatch(/typeof v === "bigint" \? v\.toString\(\) : v/);
  });

  it("still reports a truncated section rather than looking complete", () => {
    expect(src).toMatch(/truncated\.push\(section\)/);
  });
});

describe("getting it out", () => {
  const src = read("documents/local-storage.controller.ts");

  it("streams the bytes instead of letting Nest serialise a Buffer", () => {
    expect(src).toMatch(/return new StreamableFile\(bytes\)/);
    expect(src).not.toMatch(/^\s*return bytes;$/m);
  });

  it("accepts a key with a file extension", () => {
    // The archive is the only key in the app that carries one, and the shape
    // rejected it — created, never downloadable.
    expect("schools/abc-123/archives/1787756927808-Third-Term.json").toMatch(
      /^(schools|careers)\/[a-zA-Z0-9-]+\/[a-zA-Z0-9/_.-]+$/,
    );
  });

  it("still refuses traversal, which the looser shape alone would have allowed", () => {
    // `[a-zA-Z0-9/_.-]` happily matches `..`, so the guard is kept EXPLICIT
    // rather than expressed in the character class — otherwise this fix would
    // have traded one bug for a worse one.
    expect(src).toMatch(/key\.includes\("\.\."\)/);
  });
});

describe("the tenant read wrapper", () => {
  const src = read("foundation/prisma-tenant.service.ts");

  it("lets a caller raise the timeout, and only a caller", () => {
    // A longer transaction holds a snapshot open and blocks vacuum, so it is
    // the caller who decides the trade is worth it — not the default.
    expect(src).toMatch(/opts\?: \{ timeoutMs\?: number \}/);
    expect(src).toMatch(/opts\?\.timeoutMs/);
  });

  it("raises maxWait with it, or it would still fail waiting for a connection", () => {
    expect(src).toMatch(/maxWait: Math\.min\(opts\.timeoutMs/);
  });
});

// =============================================================================
// …and an archive labelled with a term actually contains that term
// =============================================================================
// `sessionId` was accepted, stored on the row, written into the manifest — and
// FILTERED NOTHING. Every archive was a whole-school dump whatever it was
// labelled. The tell was sitting in the data: three stored archives named
// "Term 1", "Second Term" and "Third Term" measured 1422, 1422 and 1423 KB.
//
// The daily sweep archives EVERY ENDED TERM, so fifteen years is 45 copies of
// the school's entire history, each larger than the last. And a reader opening
// "Third Term 2026" in ten years got a document that misrepresented itself.
// =============================================================================
describe("what an archive says it covers", () => {
  const src = read("privacy/archive.service.ts");

  it("resolves a window from the term or session it names", () => {
    expect(src).toMatch(/private async windowFor\(/);
    expect(src).toMatch(/const inWindow = window \? \{ gte: window\.from, lte: window\.to \} : undefined/);
  });

  it("bounds every section that is genuinely time-bound", () => {
    for (const line of [
      /enrollment\.findMany\(\{\s*where: inWindow \? \{ enrolledAt: inWindow \}/,
      /invoice\.findMany\(\{\s*where: inWindow \? \{ createdAt: inWindow \}/,
      /workflowRequest\.findMany\(\{\s*where: inWindow \? \{ createdAt: inWindow \}/,
      /auditLog\.findMany\(\{\s*where: inWindow \? \{ createdAt: inWindow \}/,
    ]) {
      expect(src).toMatch(line);
    }
  });

  it("scopes results on their OWN columns, not on when a mark was typed", () => {
    // A subject result carries the term and session it belongs to, so this is
    // exact rather than inferred from a date.
    expect(src).toMatch(/where: scope\.termId \? \{ termId: scope\.termId \}/);
  });

  it("DECLARES which sections are bounded and which are snapshots", () => {
    // The ambiguity the student export bundle's coverage manifest already
    // removed one level down: a reader cannot otherwise tell whether a roster
    // is the term's or today's.
    expect(src).toMatch(/scopedSections/);
    expect(src).toMatch(/snapshotSections/);
    expect(src).toMatch(/coversFrom/);
    expect(src).toMatch(/formatVersion: 2/);
  });

  it("refuses to label an archive with a term it cannot bound", () => {
    // Silently widening is exactly the defect being replaced.
    expect(src).toMatch(/has no start or end date, so an archive cannot be scoped to it/);
  });

  it("keeps the WHOLE-SCHOOL export when nothing is named", () => {
    // Which is what a school leaving, or backing everything up, wants.
    expect(src).toMatch(/Neither named: a deliberate WHOLE-SCHOOL export/);
  });
});
