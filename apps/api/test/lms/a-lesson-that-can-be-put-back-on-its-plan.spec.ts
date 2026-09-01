/**
 * A LINK THAT COULD BE MADE ONCE AND NEVER REPAIRED.
 *
 * `lms_content.syllabusItemId` files a lesson against the week of the scheme of
 * work it teaches. `createContent` accepted it; `updateContent` did not. The FK
 * is ON DELETE SET NULL, so editing the plan NULLS the link — and this repo
 * already recorded the consequence: "a teacher CANNOT put it back". Their only
 * recovery was to delete the lesson and make it again, losing its revision
 * history with it.
 *
 * The method's own comment states the principle it was breaking, about a
 * different field: "A guard on one write path and not the other is not a guard."
 * The same is true of the field itself — a link that can only be made one way
 * is a link the product cannot maintain.
 *
 * AND NO SCREEN COULD SET IT EITHER, which is why the sweep in
 * `a-field-no-screen-can-fill-in` listed it: the create form had no picker, so
 * the whole feature was reachable only by calling the API directly.
 *
 * Driven live: create linked to week 2 (201) -> RE-LINK to week 1 (200) ->
 * detach (200) -> a topic belonging to nobody (400, named).
 */
import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";

const SERVICE = stripComments(readFileSync(
  join(__dirname, "..", "..", "src", "lms", "lms-content.service.ts"),
  "utf8",
));
const CONTROLLER = stripComments(readFileSync(
  join(__dirname, "..", "..", "src", "lms", "lms-content.controller.ts"),
  "utf8",
));
const FORM = stripComments(readFileSync(
  join(__dirname, "..", "..", "..", "web", "components", "lms", "ContentManager.tsx"),
  "utf8",
));

function methodBody(src: string, signature: string): string {
  const stripped = src.replace(/(^|[^:])\/\/.*$/gm, "$1");
  const start = stripped.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  let parens = 0;
  let i = stripped.indexOf("(", start);
  for (; i < stripped.length; i++) {
    if (stripped[i] === "(") parens++;
    else if (stripped[i] === ")" && --parens === 0) break;
  }
  let depth = 0;
  i = stripped.indexOf("{", i);
  const from = i;
  for (; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}" && --depth === 0) break;
  }
  const body = stripped.slice(from, i + 1);
  expect(body.length).toBeGreaterThan(200);
  return body;
}

describe("the update path can repair the link", () => {
  it("accepts a syllabus item, like create does", () => {
    const schema = CONTROLLER.slice(
      CONTROLLER.indexOf("const updateSchema"),
      CONTROLLER.indexOf("const applyGradesSchema"),
    );
    expect(schema).toContain("syllabusItemId");
    // NULLISH, so detaching is expressible and an absent field still means
    // "leave it alone".
    expect(schema).toMatch(/syllabusItemId: z\.string\(\)\.uuid\(\)\.nullish\(\)/);
  });

  it("validates it against the class, exactly as create does", () => {
    // The id is a plain uuid; without this a teacher could point their notes at
    // another class's week and they would surface under a plan they have no
    // part in.
    const body = methodBody(SERVICE, "async updateContent(");
    expect(body).toContain("validateSyllabusTopic(tx, row.classId");
  });

  it("only writes the link when the caller actually sent the field", () => {
    // An absent field must not detach content somebody merely renamed.
    const body = methodBody(SERVICE, "async updateContent(");
    expect(body).toContain("input.syllabusItemId !== undefined");
    expect(body).toMatch(/\.\.\.\(topic \? \{ syllabusItemId: topic\.itemId \} : \{\}\)/);
  });
});

describe("attaching to a week cannot widen who sees it", () => {
  it("inherits the subject when the row has none", () => {
    // UNTAGGED means general class material, which reaches every pupil. So
    // attaching notes to a week of the Physics plan without tagging Physics
    // hands the Physics handout to pupils who never took it — the defect
    // `createContent` documents, reachable through the other door.
    const body = methodBody(SERVICE, "async updateContent(");
    expect(body).toMatch(/topic\?\.subjectId && !tag && !row\.subjectId/);
  });

  it("checks the caller may tag that subject before inheriting it", () => {
    const body = methodBody(SERVICE, "async updateContent(");
    expect(body).toMatch(/if \(inherited\) await this\.assertMayTagSubject/);
  });

  it("never RE-tags a row that already carries a subject", () => {
    // Re-deriving it from the topic would silently retag content somebody
    // deliberately tagged; an explicit subject in the request wins too.
    const body = methodBody(SERVICE, "async updateContent(");
    expect(body).toContain("!row.subjectId");
    expect(body).toContain("!tag");
  });
});

describe("a teacher can set it from the product", () => {
  it("the create form sends it", () => {
    expect(FORM).toMatch(/syllabusItemId: syllabusItemId \|\| null/);
  });

  it("offers the weeks of the plan for the chosen subject", () => {
    expect(FORM).toContain('htmlFor="ct-week"');
    expect(FORM).toMatch(/Week \{w\.week\}/);
  });

  it("asks for the plan only once a subject AND a term are known", () => {
    // A syllabus is one (class, subject, term). Without both there is nothing
    // to fetch, and a control that renders empty is worse than none.
    expect(FORM).toMatch(/if \(!subjectId \|\| !termId\)/);
  });

  it("clears the week when the subject changes", () => {
    // A week from the previous subject's plan would be refused by the server;
    // offering it is how somebody meets that refusal.
    const effect = FORM.slice(FORM.indexOf("React.useEffect(() => {"), FORM.indexOf("}, [classId, subjectId, termId]);"));
    expect(effect).toContain('setSyllabusItemId("")');
  });
});
