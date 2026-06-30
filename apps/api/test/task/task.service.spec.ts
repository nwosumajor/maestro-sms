// =============================================================================
// TaskService — assignment scoping + self-update unit tests
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TaskService } from "../../src/task/task.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const manager: Principal = { schoolId: "A", userId: "mgr", roles: ["teacher"], permissions: ["task.assign", "task.participate"] };
const assignee: Principal = { schoolId: "A", userId: "stu1", roles: ["student"], permissions: ["task.participate"] };

function makeTx(over: Record<string, unknown> = {}) {
  const calls = { taskCreate: 0, assignCreate: 0, assignUpdate: 0 };
  const tx = {
    user: { findMany: jest.fn().mockResolvedValue(over.users ?? [{ id: "stu1" }, { id: "stu2" }]), findFirst: jest.fn().mockResolvedValue({ id: "stu1", name: "Stu" }) },
    task: {
      create: jest.fn(() => { calls.taskCreate++; return Promise.resolve({ id: "t1" }); }),
      findFirst: jest.fn().mockResolvedValue(over.task ?? { id: "t1", createdById: "mgr" }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: "t1", title: "T", description: null, createdById: "mgr", status: "OPEN", dueAt: null, createdAt: new Date() }),
      update: jest.fn().mockResolvedValue({}),
    },
    taskAssignment: {
      create: jest.fn(() => { calls.assignCreate++; return Promise.resolve({ id: "ta1" }); }),
      findFirst: jest.fn().mockResolvedValue(over.assignment ?? null),
      findMany: jest.fn().mockResolvedValue(over.assignments ?? []),
      update: jest.fn(() => { calls.assignUpdate++; return Promise.resolve({}); }),
    },
    taskComment: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  return { tx, calls };
}

function svc(tx: TenantTx) {
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const storage = { presignUpload: jest.fn(), presignDownload: jest.fn(), delete: jest.fn() };
  return new TaskService(db as never, audit as never, storage as never);
}

describe("TaskService", () => {
  it("creates a task with one assignment per assignee", async () => {
    const { tx, calls } = makeTx({ users: [{ id: "stu1" }, { id: "stu2" }] });
    await svc(tx).createTask(manager, { title: "Read chapter 1", assigneeIds: ["stu1", "stu2"] });
    expect(calls.taskCreate).toBe(1);
    expect(calls.assignCreate).toBe(2);
  });

  it("rejects creating a task with unknown assignees", async () => {
    const { tx } = makeTx({ users: [{ id: "stu1" }] }); // only 1 of 2 found
    await expect(svc(tx).createTask(manager, { title: "X", assigneeIds: ["stu1", "ghost"] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("an assignee can update THEIR assignment", async () => {
    const { tx, calls } = makeTx({ assignment: { id: "ta1", taskId: "t1", assigneeId: "stu1" }, assignments: [{ id: "ta1", assigneeId: "stu1", status: "IN_PROGRESS", note: null, attachmentName: null, attachmentKey: null }] });
    await svc(tx).updateMyAssignment(assignee, "t1", { status: "IN_PROGRESS" });
    expect(calls.assignUpdate).toBe(1);
  });

  it("a non-assignee cannot update an assignment (404, no leak)", async () => {
    const { tx } = makeTx({ assignment: null }); // caller has no assignment on this task
    await expect(svc(tx).updateMyAssignment(assignee, "t1", { status: "DONE" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a user with no relationship to a task cannot comment (404)", async () => {
    const { tx } = makeTx({ task: { id: "t1", createdById: "someone-else" }, assignment: null });
    await expect(svc(tx).comment(assignee, "t1", "hello")).rejects.toBeInstanceOf(NotFoundException);
  });
});
