// =============================================================================
// StaffLifecycleService — onboarding/offboarding, documents (expiry), training
// =============================================================================
// HR maintains a staff member's lifecycle: an onboarding/offboarding CHECKLIST
// (seeded with default tasks), compliance DOCUMENTS with an expiry, and TRAINING
// records. Expiring documents drive REMINDERS (in-app notifications to HR), made
// idempotent by `reminderSentAt`. Tenant-isolated (RLS); reads/writes gated by
// hr.read / hr.write; every mutation is audit-logged. No hard delete.
// =============================================================================

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ChecklistItemDto, StaffChecklistDto, StaffDocumentDto, TrainingRecordDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";

const DEFAULT_ITEMS: Record<string, string[]> = {
  ONBOARDING: [
    "Sign employment contract",
    "Submit ID & certificates",
    "IT accounts created",
    "Induction / orientation",
    "Add to payroll",
  ],
  OFFBOARDING: [
    "Revoke system access",
    "Return equipment",
    "Handover notes",
    "Final settlement",
    "Exit interview",
  ],
};
const HR_ROLES = ["hr_clerk", "hr_manager", "school_admin", "principal"];
const REMINDER_WINDOW_DAYS = 30;

@Injectable()
export class StaffLifecycleService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- checklists ------------------------------------------------------------
  async createChecklist(p: Principal, userId: string, type: "ONBOARDING" | "OFFBOARDING"): Promise<StaffChecklistDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId }, select: { id: true, name: true } });
      if (!user) throw new NotFoundException("User not found");
      const checklist = await tx.staffChecklist.create({
        data: { schoolId: p.schoolId, userId, type, status: "OPEN", createdById: p.userId },
      });
      const labels = DEFAULT_ITEMS[type] ?? [];
      await Promise.all(
        labels.map((label, i) =>
          tx.staffChecklistItem.create({ data: { schoolId: p.schoolId, checklistId: checklist.id, label, sequence: i } }),
        ),
      );
      await this.audit.record(
        { actorId: p.userId, action: "hr.checklist.create", entity: "staff_checklist", entityId: checklist.id, schoolId: p.schoolId, metadata: { userId, type } },
        tx,
      );
      const items = await tx.staffChecklistItem.findMany({ where: { checklistId: checklist.id }, orderBy: { sequence: "asc" } });
      return this.checklistDto(checklist, items, user.name);
    });
  }

  async listChecklists(p: Principal, userId?: string): Promise<StaffChecklistDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const lists = await tx.staffChecklist.findMany({ where: userId ? { userId } : {}, orderBy: { createdAt: "desc" } });
      const items = await tx.staffChecklistItem.findMany({ where: { checklistId: { in: lists.map((l) => l.id) } }, orderBy: { sequence: "asc" } });
      const users = await tx.user.findMany({ where: { id: { in: [...new Set(lists.map((l) => l.userId))] } }, select: { id: true, name: true } });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      const byChecklist = new Map<string, typeof items>();
      for (const it of items) (byChecklist.get(it.checklistId) ?? byChecklist.set(it.checklistId, []).get(it.checklistId)!).push(it);
      return lists.map((l) => this.checklistDto(l, byChecklist.get(l.id) ?? [], nameById.get(l.userId) ?? null));
    });
  }

  async toggleItem(p: Principal, itemId: string, done: boolean): Promise<StaffChecklistDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const item = await tx.staffChecklistItem.findFirst({ where: { id: itemId } });
      if (!item) throw new NotFoundException("Checklist item not found");
      await tx.staffChecklistItem.update({
        where: { id: itemId },
        data: { done, doneById: done ? p.userId : null, doneAt: done ? new Date() : null },
      });
      const items = await tx.staffChecklistItem.findMany({ where: { checklistId: item.checklistId }, orderBy: { sequence: "asc" } });
      const allDone = items.every((i) => i.done);
      const checklist = await tx.staffChecklist.update({
        where: { id: item.checklistId },
        data: { status: allDone ? "COMPLETED" : "OPEN" },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.checklist.item.toggle", entity: "staff_checklist_item", entityId: itemId, schoolId: p.schoolId, metadata: { done } },
        tx,
      );
      const user = await tx.user.findFirst({ where: { id: checklist.userId }, select: { name: true } });
      return this.checklistDto(checklist, items, user?.name ?? null);
    });
  }

  // --- documents -------------------------------------------------------------
  async addDocument(
    p: Principal,
    userId: string,
    input: { kind: string; name: string; documentId?: string | null; expiresAt?: string | null },
  ): Promise<StaffDocumentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId }, select: { id: true, name: true } });
      if (!user) throw new NotFoundException("User not found");
      const doc = await tx.staffDocument.create({
        data: {
          schoolId: p.schoolId,
          userId,
          kind: input.kind,
          name: input.name,
          documentId: input.documentId ?? null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdById: p.userId,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.document.add", entity: "staff_document", entityId: doc.id, schoolId: p.schoolId, metadata: { userId, kind: input.kind } },
        tx,
      );
      return this.documentDto(doc, user.name);
    });
  }

  async listDocuments(p: Principal, userId?: string): Promise<StaffDocumentDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const docs = await tx.staffDocument.findMany({ where: userId ? { userId } : {}, orderBy: { expiresAt: "asc" } });
      const users = await tx.user.findMany({ where: { id: { in: [...new Set(docs.map((d) => d.userId))] } }, select: { id: true, name: true } });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      return docs.map((d) => this.documentDto(d, nameById.get(d.userId) ?? null));
    });
  }

  /** Notify HR of documents expiring within the window (idempotent via reminderSentAt). */
  async runDocumentReminders(p: Principal): Promise<{ reminded: number }> {
    const due = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const cutoff = new Date(Date.now() + REMINDER_WINDOW_DAYS * 86_400_000);
      const docs = await tx.staffDocument.findMany({
        where: { reminderSentAt: null, expiresAt: { not: null, lte: cutoff } },
      });
      if (docs.length === 0) return [];
      const users = await tx.user.findMany({ where: { id: { in: docs.map((d) => d.userId) } }, select: { id: true, name: true } });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      const hrRoles = await tx.role.findMany({ where: { name: { in: HR_ROLES } }, select: { id: true } });
      const hrUserRoles = await tx.userRole.findMany({ where: { roleId: { in: hrRoles.map((r) => r.id) } }, select: { userId: true } });
      const recipients = [...new Set(hrUserRoles.map((ur) => ur.userId))];
      const now = new Date();
      for (const d of docs) {
        await tx.staffDocument.update({ where: { id: d.id }, data: { reminderSentAt: now } });
      }
      await this.audit.record(
        { actorId: p.userId, action: "hr.document.reminders.run", entity: "staff_document", entityId: p.schoolId, schoolId: p.schoolId, metadata: { count: docs.length } },
        tx,
      );
      return docs.map((d) => ({ name: d.name, kind: d.kind, who: nameById.get(d.userId) ?? "a staff member", expiresAt: d.expiresAt, recipients }));
    });
    // Enqueue notifications OUTSIDE the tenant tx (the notifier opens its own).
    for (const d of due) {
      for (const recipientId of d.recipients) {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId,
          type: "GENERIC",
          title: "Staff document expiring soon",
          body: `${d.who}'s ${d.kind} (“${d.name}”) expires on ${d.expiresAt ? new Date(d.expiresAt).toISOString().slice(0, 10) : "soon"}.`,
        });
      }
    }
    return { reminded: due.length };
  }

  // --- training --------------------------------------------------------------
  async addTraining(
    p: Principal,
    userId: string,
    input: { title: string; provider?: string | null; status?: string; completedAt?: string | null; expiresAt?: string | null },
  ): Promise<TrainingRecordDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId }, select: { id: true, name: true } });
      if (!user) throw new NotFoundException("User not found");
      const rec = await tx.trainingRecord.create({
        data: {
          schoolId: p.schoolId,
          userId,
          title: input.title,
          provider: input.provider ?? null,
          status: input.status ?? "PLANNED",
          completedAt: input.completedAt ? new Date(input.completedAt) : null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdById: p.userId,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.training.add", entity: "training_record", entityId: rec.id, schoolId: p.schoolId, metadata: { userId } },
        tx,
      );
      return this.trainingDto(rec, user.name);
    });
  }

  async listTraining(p: Principal, userId?: string): Promise<TrainingRecordDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const recs = await tx.trainingRecord.findMany({ where: userId ? { userId } : {}, orderBy: { createdAt: "desc" } });
      const users = await tx.user.findMany({ where: { id: { in: [...new Set(recs.map((r) => r.userId))] } }, select: { id: true, name: true } });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      return recs.map((r) => this.trainingDto(r, nameById.get(r.userId) ?? null));
    });
  }

  // --- decorators ------------------------------------------------------------
  private checklistDto(
    l: { id: string; userId: string; type: string; status: string; createdAt: Date },
    items: Array<{ id: string; label: string; sequence: number; done: boolean; doneAt: Date | null }>,
    userName: string | null,
  ): StaffChecklistDto {
    return {
      id: l.id,
      userId: l.userId,
      userName,
      type: l.type,
      status: l.status,
      createdAt: l.createdAt,
      items: items.map<ChecklistItemDto>((i) => ({ id: i.id, label: i.label, sequence: i.sequence, done: i.done, doneAt: i.doneAt })),
    };
  }

  private documentDto(
    d: { id: string; userId: string; kind: string; name: string; documentId: string | null; expiresAt: Date | null; reminderSentAt: Date | null; createdAt: Date },
    userName: string | null,
  ): StaffDocumentDto {
    const days = d.expiresAt ? Math.floor((d.expiresAt.getTime() - Date.now()) / 86_400_000) : null;
    return {
      id: d.id,
      userId: d.userId,
      userName,
      kind: d.kind,
      name: d.name,
      documentId: d.documentId,
      expiresAt: d.expiresAt,
      daysUntilExpiry: days,
      reminderSentAt: d.reminderSentAt,
      createdAt: d.createdAt,
    };
  }

  private trainingDto(
    r: { id: string; userId: string; title: string; provider: string | null; status: string; completedAt: Date | null; expiresAt: Date | null; createdAt: Date },
    userName: string | null,
  ): TrainingRecordDto {
    return {
      id: r.id,
      userId: r.userId,
      userName,
      title: r.title,
      provider: r.provider,
      status: r.status,
      completedAt: r.completedAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    };
  }
}
