// =============================================================================
// The subject that vanished from a pupil's report
// =============================================================================
// A family view shows PUBLISHED results only, which is right — a provisional
// mark must not reach a pupil or a parent before the head teacher has released
// it. But the report was built from published rows alone, so a subject whose
// mark was not released yet disappeared from the report entirely.
//
// Verified live: a pupil with nine subjects of published marks; one row flipped
// to DRAFT and the console showed EIGHT, with no trace of the ninth.
//
//     Term 1 subjects the PUPIL sees: 8 (was 9)
//     draft subject present: false
//
// Looking at eight of their nine subjects, a pupil cannot tell whether the ninth
// is still being marked, is held at review, or is simply not one of theirs. And
// it is precisely the subjects that have just been pushed from a CBT exam or an
// LMS assessment — which land as DRAFT — that go quiet.
//
// The subject is now NAMED, with no figures attached. That answers "where is my
// Chemistry result" without releasing a mark nobody has approved.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/gradebook/term-result.service.ts"), "utf8");
const CARD = readFileSync(join(__dirname, "../../../web/components/gradebook/ReportCard.tsx"), "utf8");
const fn = SRC.slice(SRC.indexOf("async getStudentSessionReport("), SRC.indexOf("async generateTermScoresheetPdf("));

describe("what a family view returns", () => {
  it("still shows PUBLISHED marks only", () => {
    // The rule that must not loosen: an unapproved mark never reaches a family.
    expect(fn).toMatch(/const results = publishedOnly \? allResults\.filter\(\(r\) => r\.status === "PUBLISHED"\) : allResults;/);
  });

  it("collects the unreleased ones separately", () => {
    expect(fn).toMatch(/const awaiting = publishedOnly \? allResults\.filter\(\(r\) => r\.status !== "PUBLISHED"\) : \[\];/);
  });

  it("names them per term, with no marks attached", () => {
    const block = fn.slice(fn.indexOf("awaitingRelease: awaiting"), fn.indexOf("awaitingRelease: awaiting") + 320);
    expect(block).toMatch(/subjectName\.get\(r\.subjectId\)/);
    // Names only — no component, total or grade may ride along.
    expect(block).not.toMatch(/r\.total|r\.exam|r\.grade/);
  });

  it("is empty for staff, who already see every row", () => {
    // Otherwise a teacher's own view would list each subject twice.
    expect(fn).toMatch(/: \[\];/);
  });

  it("resolves names for BOTH sets, or an awaiting subject reads 'Unknown'", () => {
    expect(fn).toMatch(/\[\.\.\.new Set\(\[\.\.\.results, \.\.\.awaiting\]\.map\(\(r\) => r\.subjectId\)\)\]/);
  });
});

describe("the pupil's report card says so", () => {
  it("lists the subjects awaiting release", () => {
    expect(CARD).toMatch(/term\.awaitingRelease\.length > 0/);
    expect(CARD).toMatch(/Awaiting release:/);
  });

  it("says why they carry no marks", () => {
    expect(CARD).toMatch(/not been published yet/);
  });
});
