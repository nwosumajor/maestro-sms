import { GRADE_COMPONENTS } from "@sms/types";
// =============================================================================
// LmsContentService integration — real DB, app role, RLS, approval workflow
// =============================================================================
// Proves the learning-content lifecycle end to end:
//   - teacher (of class) authors content -> DRAFT (students can't see it)
//   - submit -> PENDING_APPROVAL (a workflow request is created)
//   - principal approves -> PUBLISHED (enrolled students now see it)
//   - quiz: student takes once, auto-graded; answer key stripped from their view
//   - forum: enrolled student replies in a published thread
//   - separation of duties + 404 (not 403) for non-enrolled / cross-tenant
//
// Needs TEST_DATABASE_URL (app role) + TEST_ADMIN_URL (superuser, to seed).
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { LmsContentService } from "../../src/lms/lms-content.service";
import { WorkflowService } from "../../src/workflow/workflow.service";
import { WorkflowHooksService } from "../../src/workflow/workflow-hooks.service";
import { TermResultService } from "../../src/gradebook/term-result.service";
import { StubStorageProvider } from "../../src/documents/storage.provider";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("LmsContentService integration (authoring, approval, quiz, forum, RLS)", () => {
  let admin: Pool;
  let svc: LmsContentService;

  const SA = randomUUID();
  const SB = randomUUID();
  const T = randomUUID(); // teacher of CLS
  const PR = randomUUID(); // principal (approver)
  const S1 = randomUUID(); // enrolled in CLS
  const S2 = randomUUID(); // NOT enrolled
  const PRB = randomUUID(); // principal in other tenant
  const CLS = randomUUID();

  const teacher = (): Principal => ({ userId: T, schoolId: SA, roles: ["teacher"], permissions: [] });
  // Carries the granular stage permission the guard would populate from the role
  // in production. The staged engine checks `permissions` directly, so a fixture
  // with an empty list can clear a legacy single-stage request and NOT a staged
  // one — which is exactly how this suite passed before publishing became
  // two-stage.
  const principal = (): Principal => ({
    userId: PR, schoolId: SA, roles: ["principal"],
    permissions: ["workflow.review", "workflow.review.principal"],
  });
  // A REAL principal: the guard populates permissions from roles, so a live approver
  // holds lms.content.approve. The fixture above deliberately does not, which is why
  // the read gap went unnoticed.
  const approver = (): Principal => ({ userId: PR, schoolId: SA, roles: ["principal"], permissions: ["lms.content.approve"] });
  const student = (u: string, s = SA): Principal => ({ userId: u, schoolId: s, roles: ["student"], permissions: [] });
  // Publishing is TWO-STAGE now — head teacher, then principal — so the suite
  // needs a second, DIFFERENT approver. One person clearing both stages is the
  // thing the chain exists to prevent, and the engine refuses it.
  const HT = randomUUID();
  const headTeacher = (): Principal => ({
    userId: HT, schoolId: SA, roles: ["head_teacher"],
    permissions: ["workflow.review", "workflow.review.head"],
  });
  /** Clear both stages. Returns the content after the final approval. */
  const publish = async (contentId: string) => {
    await svc.review(headTeacher(), contentId, "APPROVE", "ok");
    return svc.review(principal(), contentId, "APPROVE", "ok");
  };

  const QUIZ_BODY = {
    kind: "QUIZ" as const,
    quiz: {
      questions: [
        { id: "q1", type: "MCQ" as const, prompt: "2+2?", options: ["3", "4", "5"], answer: "1" },
        { id: "q2", type: "TF" as const, prompt: "Sky is blue", answer: "true" },
      ],
    },
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'LA',$2,now()),($3,'LB',$4,now())`,
      [SA, "la-" + SA, SB, "lb-" + SB],
    );
    for (const [u, s, name] of [
      [T, SA, "Teach"],
      [PR, SA, "Principal"],
      // The second approver. Publishing is two-stage, and audit_log FKs to user,
      // so a stage cleared by someone who does not exist fails on the audit write.
      [HT, SA, "HeadTeacher"],
      [S1, SA, "S1"],
      [S2, SA, "S2"],
      [PRB, SB, "PrincipalB"],
    ] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, s, u + "@t", name],
      );
    }
    await admin.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'Class A',now())`, [CLS, SA]);
    await admin.query(`INSERT INTO class_teacher (id,"schoolId","classId","teacherId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, CLS, T]);
    await admin.query(`INSERT INTO enrollment (id,"schoolId","classId","studentId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, CLS, S1]);

    const tenant = new PrismaTenantService() as never;
    // Stub the notifier: publish alerts are best-effort and need a BullMQ queue
    // (Redis) we don't run here; the service swallows failures regardless.
    const notifier = { enqueue: async () => undefined } as never;
    const hooks = new WorkflowHooksService();
    const workflow = new WorkflowService(tenant, hooks);
    const termResults = new TermResultService(tenant, new AuditLogService() as never, workflow, hooks, { academicInTx: async () => ({ calendarTemplate: "THREE_TERM", grading: { components: GRADE_COMPONENTS } }), academicForSchool: async () => ({ calendarTemplate: "THREE_TERM", grading: { components: GRADE_COMPONENTS } }) } as never);
    svc = new LmsContentService(
      tenant,
      new AuditLogService() as never,
      workflow,
      notifier,
      new StubStorageProvider(),
      termResults,
    );
  });

  afterAll(async () => {
    // lms_content_revision and xapi_statement have NO foreign key to school, so
    // deleting the school below leaves them behind as unreachable orphans. Clear
    // them explicitly — children before lms_content (revision references it).
    for (const t of ["lms_content_revision", "xapi_statement", "forum_post", "quiz_attempt", "lms_content", "workflow_audit_log", "workflow_request"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    }
    for (const t of ["enrollment", "class_teacher", "class", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, [[SA, SB]]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("lesson: draft hidden from students, published after principal approval", async () => {
    const c = await svc.createContent(teacher(), {
      classId: CLS,
      type: "LESSON",
      title: "Intro",
      body: { kind: "LESSON", blocks: [{ type: "paragraph", text: "hello" }] },
    });
    expect(c.status).toBe("DRAFT");

    // Student can't see a draft, and a non-enrolled student can't see anything.
    expect((await svc.listContent(student(S1), CLS)).length).toBe(0);
    await expect(svc.getContent(student(S1), c.id)).rejects.toThrow(/not found/i);
    await expect(svc.listContent(student(S2), CLS)).rejects.toThrow(/not found/i);

    // Submit -> pending; a workflow request is attached.
    const submitted = await svc.submitForApproval(teacher(), c.id);
    expect(submitted.status).toBe("PENDING_APPROVAL");
    expect(submitted.approvalRequestId).toBeTruthy();

    // Author cannot approve their own content (separation of duties).
    await expect(svc.review(teacher(), c.id, "APPROVE")).rejects.toThrow();

    // Head teacher approves -> STILL pending: one approval is not enough.
    const afterFirst = await svc.review(headTeacher(), c.id, "APPROVE", "ok");
    expect(afterFirst.status).toBe("PENDING_APPROVAL");
    // Principal approves -> published; enrolled student now sees it.
    const approved = await svc.review(principal(), c.id, "APPROVE", "ok");
    expect(approved.status).toBe("PUBLISHED");
    const seen = await svc.listContent(student(S1), CLS);
    expect(seen.map((x) => x.id)).toContain(c.id);
  });

  it("quiz: auto-graded, single attempt, answer key hidden from the student", async () => {
    const q = await svc.createContent(teacher(), { classId: CLS, type: "QUIZ", title: "Q1", body: QUIZ_BODY });
    await svc.submitForApproval(teacher(), q.id);
    await publish(q.id);

    // The student's view never carries the answer key.
    const studentView = await svc.getContent(student(S1), q.id);
    const body = studentView.body as { kind: string; quiz: { questions: { answer: string }[] } };
    expect(body.quiz.questions.every((x) => x.answer === "")).toBe(true);

    // Correct answers -> full marks; a second attempt is rejected once the
    // per-quiz attempt cap (default 1) is spent.
    const res = await svc.attemptQuiz(student(S1), q.id, { q1: "1", q2: "true" });
    expect(res).toMatchObject({ score: 2, total: 2 });
    await expect(svc.attemptQuiz(student(S1), q.id, { q1: "1", q2: "true" })).rejects.toThrow(/no attempts left/i);
  });

  it("forum: enrolled student replies in a published thread", async () => {
    const f = await svc.createContent(teacher(), {
      classId: CLS,
      type: "FORUM_THREAD",
      title: "Discuss",
      body: { kind: "FORUM_THREAD", intro: "Welcome" },
    });
    await svc.submitForApproval(teacher(), f.id);
    await publish(f.id);

    const post = await svc.postForum(student(S1), f.id, "Great lesson!");
    expect(post.body).toBe("Great lesson!");
    const posts = await svc.listForum(student(S1), f.id);
    expect(posts.map((x) => x.body)).toContain("Great lesson!");
    // A non-enrolled student cannot post.
    await expect(svc.postForum(student(S2), f.id, "hi")).rejects.toThrow(/not found/i);
  });

  it("cross-tenant: another school's principal cannot see or approve content", async () => {
    const c = await svc.createContent(teacher(), {
      classId: CLS,
      type: "LESSON",
      title: "Secret",
      body: { kind: "LESSON", blocks: [{ type: "paragraph", text: "x" }] },
    });
    await svc.submitForApproval(teacher(), c.id);
    await expect(svc.getContent(student(PRB, SB), c.id)).rejects.toThrow(/not found/i);
    await expect(svc.review({ userId: PRB, schoolId: SB, roles: ["principal"], permissions: [] }, c.id, "APPROVE")).rejects.toThrow(/not found/i);
  });

  // ===========================================================================
  // Content listing: bounded reads, filters, and the cross-class learning view
  // ===========================================================================
  describe("listing and my learning", () => {
    it("filters the class list by TYPE and (for staff) by STATUS", async () => {
      const quizzes = await svc.listContent(teacher(), CLS, { type: "QUIZ" });
      expect(quizzes.length).toBeGreaterThan(0);
      expect(quizzes.every((c) => c.type === "QUIZ")).toBe(true);

      const published = await svc.listContent(teacher(), CLS, { status: "PUBLISHED" });
      expect(published.every((c) => c.status === "PUBLISHED")).toBe(true);
      // A term of mixed content is one undifferentiated list without this.
      const all = await svc.listContent(teacher(), CLS);
      expect(all.length).toBeGreaterThanOrEqual(quizzes.length);
    });

    it("a STUDENT's status filter can only narrow within PUBLISHED, never widen", async () => {
      // Asking for DRAFT as a student must not reveal drafts — the service pins the
      // status for non-staff before the caller's value is considered.
      const asStudent = await svc.listContent(student(S1), CLS, { status: "DRAFT" });
      expect(asStudent.every((c) => c.status === "PUBLISHED")).toBe(true);
    });

    it("my learning aggregates published content across a student's classes", async () => {
      const mine = await svc.myLearning(student(S1));
      expect(mine.items.length).toBeGreaterThan(0);
      // Published only — a student must never see a draft here either.
      expect(mine.items.every((i) => !!i.className && i.className !== "—")).toBe(true);
      expect(mine.outstanding).toBe(mine.items.filter((i) => !i.completed).length);
      // Unfinished first: a to-do list that buries the to-dos is just an archive.
      const flags = mine.items.map((i) => Number(i.completed));
      expect([...flags].sort((a, b) => a - b)).toEqual(flags);

      const published = await svc.listContent(student(S1), CLS);
      expect(mine.items.length).toBe(published.length);
    });

    it("my learning is empty for a student with no enrolments", async () => {
      // S2 is deliberately not enrolled — this must be an empty list, not an error
      // and not another class's work.
      expect(await svc.myLearning(student(S2))).toEqual({ outstanding: 0, items: [] });
    });
  });

  // ===========================================================================
  // The content APPROVER can read what they are approving — but still not author
  // ===========================================================================
  describe("approver visibility", () => {
    it("lists a class's content without teaching it (previously 404)", async () => {
      // A principal is deliberately NOT school-wide for content authoring, and
      // canAuthor gated the READ too — so the approver could approve from the
      // /workflows inbox without ever being able to open the item and read it.
      const seen = await svc.listContent(approver(), CLS);
      expect(seen.length).toBeGreaterThan(0);
      // Everything, not just published — you cannot review a draft you cannot see.
      const asTeacher = await svc.listContent(teacher(), CLS);
      expect(seen.length).toBe(asTeacher.length);
    });

    it("opens a DRAFT item, answer key included, so a quiz can actually be reviewed", async () => {
      const draft = await svc.createContent(teacher(), {
        classId: CLS,
        type: "QUIZ",
        title: "Approver Sees This",
        body: QUIZ_BODY,
      });
      expect(draft.status).toBe("DRAFT");

      const asApprover = await svc.getContent(approver(), draft.id);
      expect(asApprover.title).toBe("Approver Sees This");
      // The answer key must NOT be stripped: approving a quiz you cannot read the
      // answers of is not a review.
      const body = asApprover.body as { quiz: { questions: { answer: string }[] } };
      expect(body.quiz.questions.some((q) => q.answer !== "")).toBe(true);
    });

    it("still CANNOT author — visibility widened, write access did not", async () => {
      // The whole point of separating the two: every write path still goes through
      // assertTeacherOfClass -> canAuthor, which this change did not touch.
      await expect(
        svc.createContent(approver(), {
          classId: CLS,
          type: "LESSON",
          title: "Should Be Refused",
          body: { kind: "LESSON", blocks: [{ type: "paragraph", text: "no" }] },
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("a plain teacher of ANOTHER class still sees nothing (no general widening)", async () => {
      // The gate is the approval PERMISSION, not "any staff".
      const outsider: Principal = { userId: S2, schoolId: SA, roles: ["teacher"], permissions: [] };
      await expect(svc.listContent(outsider, CLS)).rejects.toThrow(/not found/i);
    });
  });
});
