import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

/**
 * §4: the platform owner publishes a scholarship's results to every school —
 * SCHOOL, POSITION and SCORE, and never the pupil's name.
 *
 * That naming decision is the owner's and it is the right one. This is a
 * CROSS-TENANT table read by every school on the platform, and naming a minor
 * in it is a disclosure the family never asked for. The Ultimate arena reached
 * the same place by a different route — handles across schools, never real
 * names — so this is the platform's second cross-tenant table and it carries no
 * more PII than the first.
 */

const src = (...p: string[]) => stripComments(readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8"));
const ADMIN = src("apps", "api", "src", "scholarship", "scholarship-admin.service.ts");
const CONTROLLER = src("apps", "api", "src", "scholarship", "scholarship.controller.ts");
const DTO = src("packages", "types", "src", "dto", "scholarship.ts");
const CARD = src("apps", "web", "components", "scholarship", "PublishedResults.tsx");
const OPERATOR = src("apps", "web", "components", "operator", "ScholarshipAdmin.tsx");

const method = (name: string) => {
  const at = ADMIN.indexOf(`async ${name}(`);
  expect(at).toBeGreaterThan(0);
  const next = ADMIN.indexOf("\n  async ", at + 1);
  return ADMIN.slice(at, next > 0 ? next : undefined);
};

describe("no pupil is named", () => {
  it("the row type carries a SCHOOL, not a person", () => {
    expect(DTO).toMatch(/interface ScholarshipResultRowDto \{[\s\S]{0,240}?schoolName: string;/);
    const row = DTO.slice(DTO.indexOf("interface ScholarshipResultRowDto"));
    const body = row.slice(0, row.indexOf("}"));
    expect(body).not.toMatch(/studentName|studentId|applicantId/);
  });

  it("the query selects nothing that identifies a child", () => {
    // THE SELECT IS THE CONTROL, not the scoping: this read is privileged by
    // necessity, because the whole point is that a school sees results from
    // schools that are not theirs.
    const body = method("publishedResults");
    expect(body).toMatch(/select: \{ programId: true, schoolId: true, examScorePct: true, awardPosition: true \}/);
    expect(body).not.toMatch(/studentId: true|student: \{/);
  });

  it("says so on the page, rather than leaving a reader to notice the absence", () => {
    // A table of scores with no names invites "whose?", and the answer belongs
    // on the page rather than in a policy nobody reads.
    expect(CARD).toMatch(/pupils are not named/i);
  });
});

describe("nothing is public until the owner decides", () => {
  it("keys on a publication date, so unpublished is INVISIBLE rather than empty", () => {
    expect(method("publishedResults")).toMatch(/where: \{ resultsPublishedAt: \{ not: null \} \}/);
  });

  it("refuses to publish a table with no scores in it", () => {
    // An empty table is a statement about every candidate who sat the exam.
    expect(method("publishResults")).toMatch(/No candidate has a score yet/);
  });

  it("keeps the FIRST publication date when published twice", () => {
    // When a result became public is a fact about the programme; moving it
    // would rewrite that fact.
    expect(method("publishResults")).toMatch(/program\.resultsPublishedAt \?\? new Date\(\)/);
  });

  it("can be withdrawn, which is the only way back once something is public", () => {
    expect(ADMIN).toMatch(/async unpublishResults/);
    expect(method("unpublishResults")).toMatch(/data: \{ resultsPublishedAt: null \}/);
  });

  it("audits both directions", () => {
    expect(method("publishResults")).toMatch(/scholarship\.results\.publish/);
    expect(method("unpublishResults")).toMatch(/scholarship\.results\.unpublish/);
  });
});

describe("it is readable by every school, and bounded", () => {
  it("opens to the same audience as the portal", () => {
    expect(CONTROLLER).toMatch(
      /@Get\("results"\)\s*\n\s*@RequirePermission\(SCHOLARSHIP_PERMISSIONS\.APPLY, WORKFLOW_PERMISSIONS\.REVIEW_PRINCIPAL\)/,
    );
  });

  it("is bounded at BOTH levels, because it grows with the platform's history", () => {
    expect(ADMIN).toMatch(/PUBLISHED_RESULTS_PROGRAMS = 10/);
    expect(ADMIN).toMatch(/PUBLISHED_RESULTS_ROWS = 50/);
    const body = method("publishedResults");
    expect(body).toMatch(/take: limit/);
    expect(body).toMatch(/take: limit \* PUBLISHED_RESULTS_ROWS/);
  });

  it("resolves rows and school names in ONE query each, never per programme", () => {
    const body = method("publishedResults");
    expect(body).toMatch(/programId: \{ in: programs\.map/);
    expect(body).toMatch(/id: \{ in: \[\.\.\.new Set\(rows\.map/);
  });

  it("ranks awarded positions first, then by score", () => {
    // A reader looking for "who won" should not scan a table sorted only by
    // percentage.
    expect(method("publishedResults")).toMatch(/\(a\.awardPosition \?\? 99\) - \(b\.awardPosition \?\? 99\)/);
  });
});

describe("the operator knows what they are publishing", () => {
  it("names what the table will contain, before the click", () => {
    // "Publish results" alone does not tell an operator whether a child is
    // about to be named on a table every tenant can read.
    expect(OPERATOR).toMatch(/EVERY school on the platform\?/);
    expect(OPERATOR).toMatch(/No pupil is named/);
  });

  it("offers the withdrawal on the same control once published", () => {
    expect(OPERATOR).toMatch(/pr\.resultsPublishedAt \? "Withdraw results" : "Publish results"/);
  });
});
