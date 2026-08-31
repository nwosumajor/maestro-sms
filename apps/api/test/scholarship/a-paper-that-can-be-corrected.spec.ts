import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A scholarship exam's questions could only ever be APPENDED from the operator
 * console — `appendQuestion` and nothing else. No read, no edit, no remove.
 *
 * So a typo in the text, or a wrong `answerIndex`, was PERMANENT on the paper
 * that decides who is awarded money; a wrong key marks every correct answer
 * wrong, for every candidate. The operator could not even SEE what they had
 * written — `examQuestionCount` is a number, and the component said so: "Fetch
 * current questions is not exposed".
 *
 * The API has always accepted `examQuestions` (the full set, which REPLACES),
 * so nothing about the server needed changing except a way to read the paper
 * back.
 */

const src = (...p: string[]) =>
  readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const CONTROLLER = src("apps", "api", "src", "scholarship", "scholarship.controller.ts");
const ADMIN = src("apps", "api", "src", "scholarship", "scholarship-admin.service.ts");
const PORTAL = src("apps", "api", "src", "scholarship", "scholarship.service.ts");
const DTO = src("packages", "types", "src", "dto", "scholarship.ts");
const UI = src("apps", "web", "components", "operator", "ScholarshipAdmin.tsx");

describe("the answer key never reaches a candidate", () => {
  it("is its OWN type on its OWN route, not a field on the shared program DTO", () => {
    // `ScholarshipProgramDto` is returned by TWO mappers — the operator
    // console's and the candidate PORTAL's. Adding the questions there would
    // make the compiler ask the portal for them too, and the obvious way to
    // satisfy it hands every applicant the answer key.
    expect(DTO).toMatch(/export interface ScholarshipExamQuestionDto/);
    expect(DTO).not.toMatch(/interface ScholarshipProgramDto[\s\S]*?examQuestions/);
  });

  it("is gated on scholarship.admin, the permission only super_admin holds", () => {
    expect(CONTROLLER).toMatch(
      /@Get\("programs\/:id\/questions"\)\s*\n\s*@RequirePermission\(SCHOLARSHIP_PERMISSIONS\.ADMIN\)/,
    );
  });

  it("leaves the portal mapper carrying the COUNT and nothing more", () => {
    // The property, and the comment that states it, must both survive.
    expect(PORTAL).toMatch(/examQuestionCount: Array\.isArray\(pr\.examQuestions\) \? pr\.examQuestions\.length : 0/);
    const mapper = PORTAL.slice(PORTAL.indexOf("committedMinor: 0"));
    expect(mapper.slice(0, mapper.indexOf("\n  }"))).not.toMatch(/answerIndex/);
  });
});

describe("the operator can read the paper back and correct it", () => {
  it("returns each question with its position and its key", () => {
    // The POSITION is what a removal is expressed in terms of, and the KEY is
    // the thing that could be wrong and invisible.
    const m = ADMIN.slice(ADMIN.indexOf("async listExamQuestions"));
    const body = m.slice(0, m.indexOf("\n  }"));
    expect(body).toMatch(/index,/);
    expect(body).toMatch(/answerIndex: q\.answerIndex/);
  });

  it("removes by replacing the set, which is the only thing that can shrink it", () => {
    // `appendQuestion` can only ever grow the paper.
    expect(UI).toMatch(/examQuestions: kept/);
    expect(UI).toMatch(/current\s*\n?\s*\.filter\(\(question\) => question\.index !== index\)/);
  });

  it("re-reads before replacing, so a stale page cannot drop somebody else's question", () => {
    const m = UI.slice(UI.indexOf("const removeQuestion"));
    expect(m.slice(0, m.indexOf("\n  };"))).toMatch(/const current = await loadPaper\(id\)/);
  });

  it("does not treat a failed read as an empty paper", () => {
    // That would invite the operator to type the whole thing again, and
    // `appendQuestion` would duplicate every question already there.
    expect(UI).toMatch(/if \(current === null\)/);
    expect(UI).toMatch(/Nothing has been removed/);
  });
});
