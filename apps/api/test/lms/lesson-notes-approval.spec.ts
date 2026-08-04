// =============================================================================
// Lesson notes on a topic, published only after two approvals
// =============================================================================
// Two properties, and both were one line away from being wrong.
//
//   • CONTENT PUBLISH IS TWO-STAGE. The type already went through the workflow
//     engine but with NO chain, which made it legacy single-stage — one reviewer
//     could put a lesson in front of a class alone. Content a child reads should
//     get the same two pairs of eyes as the grades they are given for it.
//   • A TOPIC LINK IS CHECKED AGAINST THE CLASS. The id is a plain uuid, so
//     nothing else stops a teacher attaching notes to another class's week.

import { GRADE_PUBLISH_CHAIN, LMS_CONTENT_PUBLISH_CHAIN, WORKFLOW_PERMISSIONS } from "@sms/types";

describe("the content-publish chain", () => {
  it("has TWO stages: head teacher, then principal", () => {
    expect(LMS_CONTENT_PUBLISH_CHAIN.map((s) => s.key)).toEqual(["HEAD", "PRINCIPAL"]);
  });

  it("gates each stage on a DIFFERENT permission", () => {
    // Two stages behind one permission is one stage wearing a hat: the same
    // person could clear both.
    const perms = LMS_CONTENT_PUBLISH_CHAIN.map((s) => s.permission);
    expect(new Set(perms).size).toBe(perms.length);
    expect(perms).toEqual([WORKFLOW_PERMISSIONS.REVIEW_HEAD, WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL]);
  });

  it("matches the grade-publish chain, which is the precedent", () => {
    // Marks and the lessons behind them travel the same route; a teacher should
    // not learn two different approval paths.
    expect(LMS_CONTENT_PUBLISH_CHAIN.map((s) => s.permission)).toEqual(
      GRADE_PUBLISH_CHAIN.map((s) => s.permission),
    );
  });

  it("ends with the principal as the final stage", () => {
    const last = LMS_CONTENT_PUBLISH_CHAIN[LMS_CONTENT_PUBLISH_CHAIN.length - 1];
    expect(last.permission).toBe(WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL);
    expect(last.label).toMatch(/final/i);
  });
});

// -----------------------------------------------------------------------------

import { LmsContentService } from "../../src/lms/lms-content.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const teacher: Principal = { schoolId: "A", userId: "t1", roles: ["teacher"], permissions: ["lms.content.write"] };

function svc(topic: { itemId: string; classId: string } | null) {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    classTeacher: { findFirst: jest.fn().mockResolvedValue({ id: "ct" }) },
    class: { findFirst: jest.fn().mockResolvedValue({ id: "c1", supervisorId: "t1" }) },
    subjectSyllabusItem: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(topic && where.id === topic.itemId ? { syllabusId: "syl" } : null),
      ),
    },
    subjectSyllabus: { findFirst: jest.fn().mockResolvedValue(topic ? { classId: topic.classId } : null) },
    lmsContent: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: "n1", ...data, authorId: "t1" });
      }),
    },
    lmsContentRevision: { create: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    user: { findFirst: jest.fn().mockResolvedValue({ name: "T" }), findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "T" }]) },
    classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue(null) },
    term: { findFirst: jest.fn().mockResolvedValue(null) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const workflow = { createRequest: jest.fn().mockResolvedValue({ id: "w1" }), submit: jest.fn().mockResolvedValue({}) };
  return {
    service: new LmsContentService(db as never, audit as never, workflow as never, undefined as never, undefined as never, undefined as never),
    created,
  };
}

const NOTE = { classId: "c1", type: "LESSON" as const, title: "Week 3 notes", body: { kind: "LESSON" as const, blocks: [{ type: "paragraph" as const, text: "Newton's first law." }] } };

describe("attaching notes to a syllabus topic", () => {
  it("stores the link when the topic belongs to this class", async () => {
    const { service, created } = svc({ itemId: "i1", classId: "c1" });
    await service.createContent(teacher, { ...NOTE, syllabusItemId: "i1" });
    expect(created[0].syllabusItemId).toBe("i1");
  });

  it("refuses a topic from ANOTHER class", async () => {
    // The id is a plain uuid — nothing else would stop this, and the notes
    // would surface under a plan the teacher has no part in.
    const { service, created } = svc({ itemId: "i1", classId: "OTHER" });
    await expect(service.createContent(teacher, { ...NOTE, syllabusItemId: "i1" })).rejects.toThrow(/different class/i);
    expect(created).toHaveLength(0);
  });

  it("refuses a topic that does not exist", async () => {
    const { service } = svc(null);
    await expect(service.createContent(teacher, { ...NOTE, syllabusItemId: "ghost" })).rejects.toThrow(/does not exist/i);
  });

  it("leaves the link null for ordinary class content", async () => {
    // Most content is not tied to a week, and that must stay the easy path.
    const { service, created } = svc(null);
    await service.createContent(teacher, NOTE);
    expect(created[0].syllabusItemId).toBeNull();
  });

  it("creates notes as DRAFT — never straight to the class", async () => {
    const { service, created } = svc({ itemId: "i1", classId: "c1" });
    await service.createContent(teacher, { ...NOTE, syllabusItemId: "i1" });
    expect(created[0].status).toBe("DRAFT");
  });
});
