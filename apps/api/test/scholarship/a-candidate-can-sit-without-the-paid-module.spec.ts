import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";

/**
 * A qualified candidate at a STANDARD school could not sit their scholarship
 * exam, in two independent ways:
 *
 *   1. The sitting routes live on `CbtController`, which is
 *      `@RequireModule(MODULES.CBT)` — a PREMIUM module. Measured live:
 *      `GET /cbt/exams` -> 404 on STANDARD, 200 on ENTERPRISE. The portal
 *      cheerfully linked them to it.
 *   2. Even with the module, `announceExam` created the exam PUBLISHED but
 *      never RELEASED, and releasing is itself a CBT-module action performed by
 *      a school's principal — for a PLATFORM exam nobody there is responsible
 *      for, and which their school may not be able to reach either.
 *
 * THE ENTITLEMENT GATE IS NOT WEAKENED. Making `@RequireModule` conditional per
 * user would leave every later reader unsure what it guarantees. Instead the
 * ALWAYS-ON scholarship surface — which this controller's own header calls "a
 * platform growth lever, open to every plan" — carries its own sitting routes
 * for its own audience, and the paid module is untouched.
 */

const src = (...p: string[]) =>
  stripComments(readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8"))
    
    ;

const CONTROLLER = src("apps", "api", "src", "scholarship", "scholarship.controller.ts");
const SERVICE = src("apps", "api", "src", "scholarship", "scholarship.service.ts");
const ADMIN = src("apps", "api", "src", "scholarship", "scholarship-admin.service.ts");
const CBT_CONTROLLER = src("apps", "api", "src", "cbt", "cbt.controller.ts");
const ROOM = src("apps", "web", "components", "cbt", "CbtExamRoom.tsx");
const PORTAL = src("apps", "web", "components", "scholarship", "ScholarshipPortal.tsx");

describe("the scholarship surface serves the exam, and stays always-on", () => {
  it("carries every sitting route the exam room needs", () => {
    for (const route of [
      '@Post("exams/:programId/start")',
      '@Get("sittings/:id")',
      '@Post("sittings/:id/answer")',
      '@Post("sittings/:id/answer-theory")',
      '@Post("sittings/:id/integrity")',
      '@Post("sittings/:id/submit")',
    ]) {
      expect(CONTROLLER).toContain(route);
    }
  });

  it("is NOT module-gated, while the CBT surface still is", () => {
    // The whole point: two doors, one of them paid.
    expect(CONTROLLER).not.toMatch(/@RequireModule/);
    expect(CBT_CONTROLLER).toMatch(/@RequireModule\(MODULES\.CBT\)/);
  });

  it("uses the scholarship's own audience, which students hold", () => {
    // Bounded on a ROUTE, not on the section comment — `src()` strips comments,
    // so slicing to one gives an empty window that passes against nothing.
    const sitting = CONTROLLER.slice(CONTROLLER.indexOf('@Post("exams/:programId/start")'));
    const block = sitting.slice(0, sitting.indexOf('@Get("programs")'));
    expect(block.length).toBeGreaterThan(500);
    expect(block.match(/@RequirePermission\(SCHOLARSHIP_PERMISSIONS\.APPLY\)/g) ?? []).toHaveLength(6);
    expect(block).not.toMatch(/CBT_PERMISSIONS/);
  });
});

describe("it cannot become a way round the paid module", () => {
  it("reaches an exam only through its SCHOLARSHIP programme", () => {
    // Resolving by `scholarshipProgramId` is what makes an ordinary school exam
    // unreachable here by construction — a plain exam id would have been a
    // module-gate bypass for every exam in the school.
    expect(SERVICE).toMatch(/where: \{ scholarshipProgramId: programId \}/);
  });

  it("refuses a sitting whose exam is not a scholarship exam", () => {
    expect(SERVICE).toMatch(/if \(!exam\?\.scholarshipProgramId\) throw new NotFoundException/);
  });

  it("guards every sitting route with that check, not just the first", () => {
    const calls = SERVICE.match(/await this\.assertScholarshipSitting\(p, sittingId\)/g) ?? [];
    expect(calls.length).toBe(5); // get, answer, submit, answer-theory, integrity
  });

  it("answers 404 for somebody else's sitting and for an ordinary exam alike", () => {
    // Distinguishable refusals would make this a way to ask what exams a school
    // is running.
    const m = SERVICE.slice(SERVICE.indexOf("private async assertScholarshipSitting"));
    const body = m.slice(0, m.indexOf("\n  }"));
    expect(body.match(/NotFoundException\("Sitting not found"\)/g) ?? []).toHaveLength(2);
  });
});

describe("a platform exam needs no school invigilator", () => {
  it("is RELEASED by the announce itself", () => {
    // A school's own scheduled exam waits for a day-of release; a scholarship
    // exam has nobody there responsible for it, and the release route is inside
    // the module the school may not have.
    expect(ADMIN.match(/releasedAt: new Date\(\)/g) ?? []).toHaveLength(2); // create + reuse
  });
});

describe("one exam room, two doors", () => {
  it("takes the surface as a parameter rather than being copied", () => {
    expect(ROOM).toMatch(/basePath = "cbt"/);
    expect(ROOM.match(/\/api\/sms\/\$\{basePath\}\/sittings\//g) ?? []).toHaveLength(4);
    expect(ROOM).not.toMatch(/\/api\/sms\/cbt\/sittings\//);
  });

  it("is opened from the portal by starting, not by a link to the paid page", () => {
    expect(PORTAL).toMatch(/StartScholarshipExam/);
    expect(PORTAL).not.toMatch(/href="\/cbt"/);
  });

  it("shows the server's refusal rather than swallowing it", () => {
    // "The window has not opened" and "not released yet" are the sentences a
    // candidate needs on the morning of an exam.
    expect(PORTAL).toMatch(/setErr\(res\.error \?\? "The exam could not be opened\."\)/);
  });
});
