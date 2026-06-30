// =============================================================================
// DiscussionService — audience gating + moderation unit tests
// =============================================================================

import { ForbiddenException } from "@nestjs/common";
import { DiscussionService } from "../../src/discussion/discussion.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "teach", roles: ["teacher"], permissions: ["discussion.participate", "discussion.moderate"] };
const student: Principal = { schoolId: "A", userId: "stu1", roles: ["student"], permissions: ["discussion.participate"] };

function makeTx(over: Record<string, unknown> = {}) {
  const calls = { postUpdate: 0, postCreate: 0 };
  const tx = {
    discussionGroup: {
      create: jest.fn().mockResolvedValue({ id: "g1" }),
      findFirst: jest.fn().mockResolvedValue(over.group ?? { id: "g1", audience: "ALL", createdById: "teach" }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: "g1", name: "G", description: null, audience: "ALL", createdById: "teach", createdAt: new Date() }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    discussionPost: {
      create: jest.fn(() => { calls.postCreate++; return Promise.resolve({ id: "po1" }); }),
      findFirst: jest.fn().mockResolvedValue(over.post ?? { id: "po1", groupId: "g1", authorId: "stu1", body: "hi", deleted: false }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: "po1", groupId: "g1", authorId: "stu1", body: "hi", deleted: over.deleted ?? false, createdAt: new Date() }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(() => { calls.postUpdate++; return Promise.resolve({}); }),
    },
    discussionComment: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "stu1", name: "Stu" }), findMany: jest.fn().mockResolvedValue([{ id: "stu1", name: "Stu" }]) },
  } as unknown as TenantTx;
  return { tx, calls };
}

function svc(tx: TenantTx) {
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return new DiscussionService(db as never, audit as never);
}

describe("DiscussionService", () => {
  it("a student cannot post in a STAFF-only group", async () => {
    const { tx } = makeTx({ group: { id: "g1", audience: "STAFF", createdById: "teach" } });
    await expect(svc(tx).createPost(student, "g1", "hello")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a student CAN post in an ALL group", async () => {
    const { tx, calls } = makeTx({ group: { id: "g1", audience: "ALL", createdById: "teach" } });
    await svc(tx).createPost(student, "g1", "hello");
    expect(calls.postCreate).toBe(1);
  });

  it("a non-moderator cannot delete a post", async () => {
    const { tx } = makeTx();
    await expect(svc(tx).deletePost(student, "po1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a moderator soft-deletes a post", async () => {
    const { tx, calls } = makeTx();
    const res = await svc(tx).deletePost(staff, "po1");
    expect(res.deleted).toBe(true);
    expect(calls.postUpdate).toBe(1);
  });

  it("a deleted post shows a tombstone, never the original body", async () => {
    const { tx } = makeTx({ deleted: true });
    const dto = await svc(tx).comment(staff, "po1", "x");
    expect(dto.body).toBe("[removed by a moderator]");
    expect(dto.body).not.toContain("hi");
  });
});
