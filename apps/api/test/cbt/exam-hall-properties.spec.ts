// =============================================================================
// The CBT exam hall, audited — one rough edge, and a record of what is sound
// =============================================================================
// This module's core promise is that a question's answer never reaches a pupil
// before it should. It holds, and the checks below exist so the next reader can
// see WHICH properties were verified rather than re-deriving them:
//
//   answer-key.pdf   @RequirePermission(cbt.manage) AND the service refuses
//                    `withAnswers` to a non-editor — two layers, either alone
//                    would do.
//   paper.pdf        deliberately ungated at the decorator because TWO
//                    permissions reach it (an author via cbt.manage + bank
//                    scope, an oversight reader via cbt.review) and
//                    @RequirePermission takes exactly one. The SERVICE enforces
//                    it, 404-not-403, and the comment saying so matches the
//                    code — checked, because a comment claiming a guard is
//                    exactly what this session has found lying twice.
//   student view     `answerIndex` only when the sitting is FINISHED and the
//                    key RELEASED (teacher requested, principal approved).
//   the clock        enforced on the WRITE, not just on display: `answer()`
//                    finalises an overdue sitting as EXPIRED and refuses, so a
//                    tab left open is not an extension.
//   own questions    `answer()` refuses a questionId outside the pupil's own
//                    sampled order — no fishing in the bank.
//   auto-marking     objective only; theory waits for a human (Golden Rule #8),
//                    the score stays on the sitting and never writes itself
//                    into the gradebook, and `finalize` CLAIMS with updateMany.
//   expiry           lazy, and complete: staff reads expire overdue sittings,
//                    and `getSitting` expires the pupil's own abandoned tab.
//
// THE ROUGH EDGE. One sitting per pupil is a DATABASE rule —
// `@@unique([examId, studentId])`, and the index really exists — so the
// find-then-create above it cannot enforce it: two clicks both find nothing and
// both insert. The integrity of the exam was never at risk; the ANSWER the
// pupil got was. An unhandled P2002 falls through the global filter (which
// translates malformed UUIDs and nothing else) and reaches the client as a 500
// — at the moment thirty pupils press Start on the same wifi.
// =============================================================================

import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";

const SRC = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");
const code = (s: string) => stripComments(s);

const SERVICE = SRC("cbt/cbt.service.ts");
const CONTROLLER = SRC("cbt/cbt.controller.ts");

function bodyOf(src: string, name: string): string {
  const m = new RegExp(`async ${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`no ${name}`);
  const open = src.indexOf("{\n", m.index);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}" && --d === 0) return code(src.slice(open, i));
  }
  throw new Error("unterminated");
}

describe("starting a sitting twice", () => {
  const body = bodyOf(SERVICE, "startSitting");

  it("recovers from the unique violation instead of 500ing", () => {
    expect(body).toMatch(/e\.code !== "P2002"/);
  });

  it("answers with the pupil's sitting, not an error", () => {
    // They asked to sit their exam. The other request made it a millisecond
    // ago; a 409 would be technically true and useless in an exam hall.
    //
    // Anchored INSIDE the catch: the same findFirst opens the method, so
    // matching it anywhere passed with the recovery deleted.
    const at = body.indexOf("catch");
    expect(at).toBeGreaterThan(-1);
    expect(body.slice(at)).toMatch(/findFirst\(\{ where: \{ examId, studentId: p\.userId \} \}\)/);
  });

  it("still rethrows anything that is not a duplicate", () => {
    expect(body).toMatch(/throw e;/);
  });

  it("leans on the database for the rule, not the read", () => {
    const schema = readFileSync(
      join(__dirname, "../../../../packages/db/prisma/schema/cbt.prisma"),
      "utf8",
    );
    expect(schema).toMatch(/@@unique\(\[examId, studentId\]\)/);
  });
});

describe("what the exam hall promises, and still keeps", () => {
  it("gates the answer key at the decorator AND in the service", () => {
    const at = CONTROLLER.indexOf('@Get("exams/:id/answer-key.pdf")');
    expect(CONTROLLER.slice(at - 120, at + 160)).toMatch(/CBT_MANAGE/);
    expect(code(SERVICE)).toMatch(/withAnswers && !isEditor/);
  });

  it("lets an author OR a reviewer print the paper, and nobody else", () => {
    const body = bodyOf(SERVICE, "examPaperPdf");
    expect(body).toMatch(/CBT_MANAGE\) && \(await this\.canTouchBank/);
    expect(body).toMatch(/CBT_REVIEW/);
    expect(body).toMatch(/if \(!isEditor && !isReviewer\) throw new NotFoundException/);
  });

  it("shows a pupil the answer only once finished AND released", () => {
    expect(code(SERVICE)).toMatch(/answerIndex: finished && released \? q\.answerIndex : null/);
  });

  it("enforces the clock on the WRITE", () => {
    const body = bodyOf(SERVICE, "answer");
    expect(body).toMatch(/this\.timeUp\(/);
    expect(body.indexOf("timeUp")).toBeLessThan(body.indexOf("cbtSitting.update"));
  });

  it("refuses a question outside the pupil's own sample", () => {
    expect(bodyOf(SERVICE, "answer")).toMatch(/order\.includes\(questionId\)/);
  });

  it("auto-marks objective questions only, and claims the finalise", () => {
    const body = bodyOf(SERVICE, "finalize");
    expect(body).toMatch(/q\.type !== "THEORY"/);
    expect(body).toMatch(/updateMany\(\{[\s\S]*?status: "IN_PROGRESS"/);
  });

  it("never writes an auto-mark into the gradebook by itself", () => {
    // Golden Rule #8. The score lives on the sitting; a human moves it.
    const body = bodyOf(SERVICE, "finalize");
    expect(body).not.toMatch(/subjectResult|gradebook|termResult/i);
  });

  it("expires an abandoned tab on the pupil's own read", () => {
    expect(bodyOf(SERVICE, "getSitting")).toMatch(/finalize\(tx, p, sitting\.id, "EXPIRED"\)/);
  });
});
