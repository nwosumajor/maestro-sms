// =============================================================================
// The vault copy of a report card is the FAMILY's, so it cannot carry an
// unpublished mark
// =============================================================================
// `generate` renders the card with the CALLER's scope, and the rule is stated in
// the service itself: "student→self, parent→children PUBLISHED-only,
// staff-of-class all". A member of staff printing before publication therefore
// gets a PDF containing DRAFT marks — correct for them.
//
// That exact buffer was then filed into the pupil's Document Vault, and
// `uploadBytes` NOTIFIES THE GUARDIANS. Measured on a real pupil of a 700-pupil
// school: the stored card carried Chemistry 83, Civic Education 49, Economics 60
// and English Language 78, none of them published, and the family was told it
// was there.
//
// GRADE_PUBLISH is a two-person gate whose whole purpose is that a mark does not
// reach a family until it is approved. The card walked round it — not by
// reading, but by DELIVERING.
//
// The fix is the restrictive one (Golden Rule #7): the caller still gets their
// own full PDF, and nothing is filed while any of the term's marks are
// unpublished. Driven both ways: 7 unpublished -> nothing filed and the response
// says so; 0 unpublished -> filed, vault copies 5 -> 6.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

const SRC = join(__dirname, "../../src");
const read = (rel: string) => {
  try { return stripComments(readFileSync(join(SRC, rel), "utf8")); } catch { return ""; }
};

/** One method's body.
 *
 *  TWO THINGS IN A SIGNATURE CAN OPEN A BRACE THAT IS NOT THE BODY, and both bit
 *  this gate: a destructured/inline PARAMETER type (`q: { classId: string }`) and
 *  an inline RETURN type (`: Promise<{ buffer: Buffer }>`). Taking the first `{`
 *  after the name yields a 35-character "body" and every assertion below then
 *  passes against nothing. So the parameter list is walked to its matching paren,
 *  and the body brace is the first one at ANGLE depth zero — a `{` inside `<...>`
 *  belongs to a type. */
function methodBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at === -1) return "";
  let i = src.indexOf("(", at);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  let angle = 0;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "<") angle += 1;
    else if (ch === ">") angle -= 1;
    else if (ch === "{" && angle === 0) break;
  }
  if (i >= src.length) return "";
  const start = i;
  depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const service = read("reportcards/reportcard.service.ts");
const controller = read("reportcards/reportcard.controller.ts");
const proxy = (() => {
  try {
    return readFileSync(join(__dirname, "../../../../apps/web/app/api/sms/[...path]/route.ts"), "utf8");
  } catch { return ""; }
})();

describe("a report card is not filed to the family's vault before the marks are published", () => {
  const body = methodBody(service, "async generate(");

  it("found the sources it is about", () => {
    // A read that finds nothing produces no offenders and passes green.
    expect(service.length).toBeGreaterThan(10000);
    expect(body.length).toBeGreaterThan(3000);
    expect(controller.length).toBeGreaterThan(1000);
    expect(proxy.length).toBeGreaterThan(1000);
  });

  it("counts the term's unpublished marks before filing anything", () => {
    expect(body).toMatch(/subjectResult\.count\([\s\S]{0,200}status:\s*\{\s*not:\s*"PUBLISHED"\s*\}/);
  });

  it("returns WITHOUT writing to the vault when any of them are unpublished", () => {
    // The order matters: the guard must sit BEFORE createDocument, or the leak
    // happens and is then reported.
    const guard = body.search(/if\s*\(\s*unpublished\s*>\s*0\s*\)/);
    const write = body.search(/documents\.createDocument/);
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
  });

  it("still gives the caller their own PDF either way", () => {
    // Withholding the FAMILY's copy must not withhold the staff member's, or the
    // fix breaks the ordinary act of previewing a card.
    expect(body).toMatch(/return \{ buffer, filename, filedToVault: false/);
    expect(body).toMatch(/return \{ buffer, filename, filedToVault: true/);
  });

  it("says what it did not do, rather than skipping silently", () => {
    expect(controller).toMatch(/X-Report-Card-Filed/);
    // and the BFF rebuilds the header set, so it must carry it across or the
    // download looks identical either way
    expect(proxy).toMatch(/x-report-card-filed/);
  });
});
