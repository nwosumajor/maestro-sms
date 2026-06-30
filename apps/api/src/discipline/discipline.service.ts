// =============================================================================
// DisciplineService — complaint intake + resolution
// =============================================================================
// Tenant-scoped (RLS). Anyone (discipline.file) files a complaint against a
// student/teacher and sees their OWN filed complaints. Staff (discipline.manage)
// see all, assign responsible resolvers, attach evidence (object storage), add
// action notes, and record a resolution. SECURITY (Golden Rule #8): this records
// HUMAN decisions only — it never auto-penalises. Evidence on minors is sensitive,
// so all reads of a complaint are audited. 404 (not 403) for out-of-scope access.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { DisciplineComplaintDto, DisciplineEvidencePresignDto } from "@sms/types";
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

const STATUSES = ["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"];

@Injectable()
export class DisciplineService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private canManage(p: Principal): boolean {
    return p.permissions.includes("discipline.manage");
  }

  // --- file (anyone) --------------------------------------------------------

  async file(
    p: Principal,
    input: { subject: string; details?: string; againstId: string; againstType: "STUDENT" | "TEACHER" },
  ): Promise<DisciplineComplaintDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const against = await tx.user.findFirst({ where: { id: input.againstId }, select: { id: true } });
      if (!against) throw new NotFoundException("The named person is not in this school");
      const c = await tx.disciplineComplaint.create({
        data: {
          schoolId: p.schoolId,
          subject: input.subject,
          details: input.details ?? null,
          complainantId: p.userId,
          againstId: input.againstId,
          againstType: input.againstType,
          status: "OPEN",
        },
      });
      await this.log(tx, p, "discipline.file", c.id, { againstType: input.againstType });
      return this.complaintDto(tx, c.id);
    });
  }

  // --- staff review ---------------------------------------------------------

  async assign(p: Principal, complaintId: string, assigneeId: string): Promise<DisciplineComplaintDto> {
    this.requireManage(p);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireComplaint(tx, complaintId);
      const u = await tx.user.findFirst({ where: { id: assigneeId }, select: { id: true } });
      if (!u) throw new NotFoundException("Assignee not found in this school");
      const dup = await tx.disciplineAssignee.findFirst({ where: { complaintId, assigneeId }, select: { id: true } });
      if (dup) throw new BadRequestException("Already assigned");
      await tx.disciplineAssignee.create({ data: { schoolId: p.schoolId, complaintId, assigneeId } });
      await this.log(tx, p, "discipline.assign", complaintId, { assigneeId });
      return this.complaintDto(tx, complaintId);
    });
  }

  async addEntry(p: Principal, complaintId: string, body: string): Promise<DisciplineComplaintDto> {
    this.requireManage(p);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireComplaint(tx, complaintId);
      await tx.disciplineEntry.create({ data: { schoolId: p.schoolId, complaintId, authorId: p.userId, body } });
      await this.log(tx, p, "discipline.entry", complaintId, {});
      return this.complaintDto(tx, complaintId);
    });
  }

  /** Record an action/resolution + status. Human decision only (Golden Rule #8). */
  async resolve(p: Principal, complaintId: string, input: { status: string; resolution?: string }): Promise<DisciplineComplaintDto> {
    this.requireManage(p);
    if (!STATUSES.includes(input.status)) throw new BadRequestException("invalid status");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireComplaint(tx, complaintId);
      await tx.disciplineComplaint.update({
        where: { id: complaintId },
        data: { status: input.status, ...(input.resolution !== undefined ? { resolution: input.resolution } : {}) },
      });
      await this.log(tx, p, "discipline.resolve", complaintId, { status: input.status });
      return this.complaintDto(tx, complaintId);
    });
  }

  // --- evidence -------------------------------------------------------------

  async presignEvidence(p: Principal, complaintId: string, input: { fileName: string; contentType: string }): Promise<DisciplineEvidencePresignDto> {
    this.requireManage(p);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireComplaint(tx, complaintId);
      const safe = input.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
      const key = `discipline/${p.schoolId}/${complaintId}/${Date.now()}_${safe}`;
      const { url } = await this.storage.presignUpload({ key, contentType: input.contentType });
      return { url, key };
    });
  }

  async confirmEvidence(p: Principal, complaintId: string, input: { key: string; fileName: string }): Promise<DisciplineComplaintDto> {
    this.requireManage(p);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireComplaint(tx, complaintId);
      const prefix = `discipline/${p.schoolId}/${complaintId}/`;
      if (!input.key.startsWith(prefix)) throw new BadRequestException("key does not match this complaint");
      await tx.disciplineEvidence.create({ data: { schoolId: p.schoolId, complaintId, uploadedById: p.userId, fileKey: input.key, fileName: input.fileName } });
      await this.log(tx, p, "discipline.evidence", complaintId, { fileName: input.fileName });
      return this.complaintDto(tx, complaintId);
    });
  }

  async downloadEvidence(p: Principal, complaintId: string, evidenceId: string): Promise<{ url: string }> {
    this.requireManage(p);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const ev = await tx.disciplineEvidence.findFirst({ where: { id: evidenceId, complaintId } });
      if (!ev) throw new NotFoundException("Evidence not found");
      await this.log(tx, p, "discipline.evidence.read", complaintId, { evidenceId });
      const { url } = await this.storage.presignDownload({ key: ev.fileKey });
      return { url };
    });
  }

  // --- reads ----------------------------------------------------------------

  /** Staff see all complaints; a filer sees only the ones they filed. */
  async list(p: Principal): Promise<DisciplineComplaintDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where = this.canManage(p) ? {} : { complainantId: p.userId };
      const rows = await tx.disciplineComplaint.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
      // Audit-log the listing of complaints (evidence on minors is sensitive).
      await this.log(tx, p, "discipline.list", "list", { count: rows.length, scope: this.canManage(p) ? "all" : "own" });
      return Promise.all(rows.map((c: { id: string }) => this.complaintDto(tx, c.id)));
    });
  }

  async get(p: Principal, complaintId: string): Promise<DisciplineComplaintDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const c = await tx.disciplineComplaint.findFirst({ where: { id: complaintId } });
      if (!c) throw new NotFoundException("Complaint not found");
      if (!this.canManage(p) && c.complainantId !== p.userId) throw new NotFoundException("Complaint not found");
      await this.log(tx, p, "discipline.read", complaintId, {});
      return this.complaintDto(tx, complaintId);
    });
  }

  // --- helpers --------------------------------------------------------------

  private requireManage(p: Principal): void {
    if (!this.canManage(p)) throw new ForbiddenException("Staff only");
  }
  private async requireComplaint(tx: TenantTx, id: string): Promise<void> {
    const c = await tx.disciplineComplaint.findFirst({ where: { id }, select: { id: true } });
    if (!c) throw new NotFoundException("Complaint not found");
  }

  private async complaintDto(tx: TenantTx, id: string): Promise<DisciplineComplaintDto> {
    const c = await tx.disciplineComplaint.findFirstOrThrow({ where: { id } });
    const assignees = await tx.disciplineAssignee.findMany({ where: { complaintId: id }, orderBy: { createdAt: "asc" } });
    const evidence = await tx.disciplineEvidence.findMany({ where: { complaintId: id }, orderBy: { createdAt: "asc" } });
    const entries = await tx.disciplineEntry.findMany({ where: { complaintId: id }, orderBy: { createdAt: "asc" } });
    const ids = [
      ...new Set([
        c.complainantId,
        c.againstId,
        ...assignees.map((a: { assigneeId: string }) => a.assigneeId),
        ...evidence.map((e: { uploadedById: string }) => e.uploadedById),
        ...entries.map((e: { authorId: string }) => e.authorId),
      ]),
    ];
    const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
    return {
      id: c.id,
      subject: c.subject,
      details: c.details,
      complainantId: c.complainantId,
      complainantName: nameOf.get(c.complainantId) ?? "",
      againstId: c.againstId,
      againstName: nameOf.get(c.againstId) ?? "",
      againstType: c.againstType,
      status: c.status,
      resolution: c.resolution,
      assignees: assignees.map((a: { id: string; assigneeId: string }) => ({ id: a.id, assigneeId: a.assigneeId, assigneeName: nameOf.get(a.assigneeId) ?? "" })),
      evidence: evidence.map((e: { id: string; uploadedById: string; fileName: string; createdAt: Date }) => ({ id: e.id, uploadedById: e.uploadedById, uploadedByName: nameOf.get(e.uploadedById) ?? "", fileName: e.fileName, createdAt: e.createdAt })),
      entries: entries.map((e: { id: string; authorId: string; body: string; createdAt: Date }) => ({ id: e.id, authorId: e.authorId, authorName: nameOf.get(e.authorId) ?? "", body: e.body, createdAt: e.createdAt })),
      createdAt: c.createdAt,
    };
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "discipline", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
