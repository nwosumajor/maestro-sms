// =============================================================================
// TaskService — assign + track tasks
// =============================================================================
// Tenant-scoped (RLS). Managers/teachers (task.assign) create tasks, assign them
// to staff/students, change task status, and comment. Assignees (task.participate)
// see only tasks they created or are assigned to, update THEIR assignment status,
// upload a document (via the pluggable StorageProvider), and comment. Audited.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TaskAttachmentPresignDto, TaskDto } from "@sms/types";
import { STORAGE_PROVIDER, type StorageProvider } from "../documents/storage.provider";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const TASK_STATUSES = ["OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
const ASSIGNEE_STATUSES = ["ASSIGNED", "IN_PROGRESS", "SUBMITTED", "DONE"];

@Injectable()
export class TaskService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private canAssign(p: Principal): boolean {
    return p.permissions.includes("task.assign");
  }

  // --- create / assign (managers) -------------------------------------------

  async createTask(
    p: Principal,
    input: { title: string; description?: string; dueAt?: string | null; assigneeIds: string[] },
  ): Promise<TaskDto> {
    if (input.assigneeIds.length === 0) throw new BadRequestException("at least one assignee is required");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const uniqueAssignees = [...new Set(input.assigneeIds)];
      const found = await tx.user.findMany({ where: { id: { in: uniqueAssignees } }, select: { id: true } });
      if (found.length !== uniqueAssignees.length) throw new BadRequestException("one or more assignees are not in this school");
      const task = await tx.task.create({
        data: {
          schoolId: p.schoolId,
          title: input.title,
          description: input.description ?? null,
          createdById: p.userId,
          status: "OPEN",
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
        },
      });
      for (const assigneeId of uniqueAssignees) {
        await tx.taskAssignment.create({ data: { schoolId: p.schoolId, taskId: task.id, assigneeId, status: "ASSIGNED" } });
      }
      await this.log(tx, p, "task.create", task.id, { title: input.title, assignees: uniqueAssignees.length });
      return this.taskDto(tx, task.id, p.userId);
    });
  }

  /** Manager changes the overall task status (e.g. close it). */
  async setStatus(p: Principal, taskId: string, status: string): Promise<TaskDto> {
    if (!TASK_STATUSES.includes(status)) throw new BadRequestException("invalid status");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const task = await tx.task.findFirst({ where: { id: taskId } });
      if (!task) throw new NotFoundException("Task not found");
      if (task.createdById !== p.userId && !this.canAssign(p)) throw new ForbiddenException("Only the creator can change the task status");
      await tx.task.update({ where: { id: taskId }, data: { status } });
      await this.log(tx, p, "task.status", taskId, { status });
      return this.taskDto(tx, taskId, p.userId);
    });
  }

  // --- assignee updates -----------------------------------------------------

  /** An assignee updates THEIR assignment status / note. */
  async updateMyAssignment(p: Principal, taskId: string, input: { status?: string; note?: string }): Promise<TaskDto> {
    if (input.status && !ASSIGNEE_STATUSES.includes(input.status)) throw new BadRequestException("invalid status");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const assignment = await tx.taskAssignment.findFirst({ where: { taskId, assigneeId: p.userId } });
      if (!assignment) throw new NotFoundException("Task not found"); // 404, not 403 (no leak)
      await tx.taskAssignment.update({
        where: { id: assignment.id },
        data: { ...(input.status ? { status: input.status } : {}), ...(input.note !== undefined ? { note: input.note } : {}) },
      });
      await this.log(tx, p, "task.assignment.update", assignment.id, { status: input.status });
      return this.taskDto(tx, taskId, p.userId);
    });
  }

  /** Presign an upload URL for the caller's own assignment attachment. */
  async presignAttachment(p: Principal, taskId: string, input: { fileName: string; contentType: string }): Promise<TaskAttachmentPresignDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const assignment = await tx.taskAssignment.findFirst({ where: { taskId, assigneeId: p.userId }, select: { id: true } });
      if (!assignment) throw new NotFoundException("Task not found");
      const safe = input.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
      const key = `tasks/${p.schoolId}/${taskId}/${p.userId}/${Date.now()}_${safe}`;
      const { url } = await this.storage.presignUpload({ key, contentType: input.contentType });
      return { url, key };
    });
  }

  /** Confirm the upload finished — record the key + name on the assignment. */
  async confirmAttachment(p: Principal, taskId: string, input: { key: string; fileName: string }): Promise<TaskDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const assignment = await tx.taskAssignment.findFirst({ where: { taskId, assigneeId: p.userId } });
      if (!assignment) throw new NotFoundException("Task not found");
      const prefix = `tasks/${p.schoolId}/${taskId}/${p.userId}/`;
      if (!input.key.startsWith(prefix)) throw new BadRequestException("key does not match this assignment");
      await tx.taskAssignment.update({ where: { id: assignment.id }, data: { attachmentKey: input.key, attachmentName: input.fileName } });
      await this.log(tx, p, "task.attachment", assignment.id, { fileName: input.fileName });
      return this.taskDto(tx, taskId, p.userId);
    });
  }

  /** A signed download URL for an assignment's attachment (creator or the assignee). */
  async downloadAttachment(p: Principal, taskId: string, assignmentId: string): Promise<{ url: string }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const task = await tx.task.findFirst({ where: { id: taskId }, select: { createdById: true } });
      const assignment = await tx.taskAssignment.findFirst({ where: { id: assignmentId, taskId } });
      if (!task || !assignment || !assignment.attachmentKey) throw new NotFoundException("Attachment not found");
      const allowed = assignment.assigneeId === p.userId || task.createdById === p.userId || this.canAssign(p);
      if (!allowed) throw new NotFoundException("Attachment not found");
      const { url } = await this.storage.presignDownload({ key: assignment.attachmentKey });
      return { url };
    });
  }

  // --- comments -------------------------------------------------------------

  async comment(p: Principal, taskId: string, body: string): Promise<TaskDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const visible = await this.canSeeTask(tx, p, taskId);
      if (!visible) throw new NotFoundException("Task not found");
      await tx.taskComment.create({ data: { schoolId: p.schoolId, taskId, authorId: p.userId, body } });
      await this.log(tx, p, "task.comment", taskId, {});
      return this.taskDto(tx, taskId, p.userId);
    });
  }

  // --- reads ----------------------------------------------------------------

  /** Tasks the caller created or is assigned to. */
  async listTasks(p: Principal): Promise<TaskDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const mine = await tx.taskAssignment.findMany({ where: { assigneeId: p.userId }, select: { taskId: true } });
      const assignedTaskIds = mine.map((a: { taskId: string }) => a.taskId);
      const tasks = await tx.task.findMany({
        where: { OR: [{ createdById: p.userId }, { id: { in: assignedTaskIds } }] },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      return Promise.all(tasks.map((t: { id: string }) => this.taskDto(tx, t.id, p.userId)));
    });
  }

  // --- helpers --------------------------------------------------------------

  private async canSeeTask(tx: TenantTx, p: Principal, taskId: string): Promise<boolean> {
    const task = await tx.task.findFirst({ where: { id: taskId }, select: { createdById: true } });
    if (!task) return false;
    if (task.createdById === p.userId) return true;
    const a = await tx.taskAssignment.findFirst({ where: { taskId, assigneeId: p.userId }, select: { id: true } });
    return Boolean(a);
  }

  private async taskDto(tx: TenantTx, taskId: string, viewerId: string): Promise<TaskDto> {
    const t = await tx.task.findFirstOrThrow({ where: { id: taskId } });
    const assignments = await tx.taskAssignment.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } });
    const comments = await tx.taskComment.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } });
    const userIds = [
      ...new Set([
        t.createdById,
        ...assignments.map((a: { assigneeId: string }) => a.assigneeId),
        ...comments.map((c: { authorId: string }) => c.authorId),
      ]),
    ];
    const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
    const myAssignment = assignments.find((a: { assigneeId: string }) => a.assigneeId === viewerId);
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      createdById: t.createdById,
      createdByName: nameOf.get(t.createdById) ?? "",
      status: t.status,
      dueAt: t.dueAt,
      assignees: assignments.map((a: { id: string; assigneeId: string; status: string; note: string | null; attachmentName: string | null; attachmentKey: string | null }) => ({
        id: a.id,
        assigneeId: a.assigneeId,
        assigneeName: nameOf.get(a.assigneeId) ?? "",
        status: a.status,
        note: a.note,
        attachmentName: a.attachmentName,
        hasAttachment: Boolean(a.attachmentKey),
      })),
      comments: comments.map((c: { id: string; authorId: string; body: string; createdAt: Date }) => ({
        id: c.id,
        authorId: c.authorId,
        authorName: nameOf.get(c.authorId) ?? "",
        body: c.body,
        createdAt: c.createdAt,
      })),
      myStatus: myAssignment?.status ?? null,
      createdAt: t.createdAt,
    };
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "task", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
