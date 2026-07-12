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
  const principal = (): Principal => ({ userId: PR, schoolId: SA, roles: ["principal"], permissions: [] });
  const student = (u: string, s = SA): Principal => ({ userId: u, schoolId: s, roles: ["student"], permissions: [] });

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
    const termResults = new TermResultService(tenant, new AuditLogService() as never, workflow, hooks);
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
    for (const t of ["forum_post", "quiz_attempt", "lms_content", "workflow_audit_log", "workflow_request"]) {
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

    // Principal approves -> published; enrolled student now sees it.
    const approved = await svc.review(principal(), c.id, "APPROVE", "ok");
    expect(approved.status).toBe("PUBLISHED");
    const seen = await svc.listContent(student(S1), CLS);
    expect(seen.map((x) => x.id)).toContain(c.id);
  });

  it("quiz: auto-graded, single attempt, answer key hidden from the student", async () => {
    const q = await svc.createContent(teacher(), { classId: CLS, type: "QUIZ", title: "Q1", body: QUIZ_BODY });
    await svc.submitForApproval(teacher(), q.id);
    await svc.review(principal(), q.id, "APPROVE");

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
    await svc.review(principal(), f.id, "APPROVE");

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
});
