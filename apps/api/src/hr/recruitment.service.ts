// =============================================================================
// RecruitmentService — job requisitions + applicant pipeline (ATS-lite)
// =============================================================================
// Tenant-isolated (RLS); gated by hr.recruit.manage. Applicants move through a
// pipeline; on HIRE, `convert` provisions a User + Employee in the SAME tenant
// (the app role may INSERT user/employee under its GUC — no privileged client
// needed, unlike cross-tenant onboarding). Every mutation is audit-logged.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Prisma } from "@sms/db";
import type { ApplicantDto, JobRequisitionDto } from "@sms/types";
import { STORAGE_PROVIDER, type StorageProvider } from "../documents/storage.provider";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const STAGES = ["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"];
const ZERO = "00000000-0000-0000-0000-000000000000"; // system actor for public intake

@Injectable()
export class RecruitmentService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- requisitions ----------------------------------------------------------
  async createRequisition(
    p: Principal,
    input: { title: string; department?: string | null; description?: string | null; openings?: number },
  ): Promise<JobRequisitionDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const r = await tx.jobRequisition.create({
        data: { schoolId: p.schoolId, title: input.title, department: input.department ?? null, description: input.description ?? null, openings: input.openings ?? 1, status: "OPEN", createdById: p.userId },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.recruit.requisition.create", entity: "job_requisition", entityId: r.id, schoolId: p.schoolId },
        tx,
      );
      return this.reqDto(r, 0);
    });
  }

  async setRequisitionStatus(p: Principal, id: string, status: string): Promise<JobRequisitionDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const r = await tx.jobRequisition.findFirst({ where: { id } });
      if (!r) throw new NotFoundException("Requisition not found");
      const updated = await tx.jobRequisition.update({ where: { id }, data: { status } });
      await this.audit.record(
        { actorId: p.userId, action: "hr.recruit.requisition.status", entity: "job_requisition", entityId: id, schoolId: p.schoolId, metadata: { status } },
        tx,
      );
      const count = await tx.applicant.count({ where: { requisitionId: id } });
      return this.reqDto(updated, count);
    });
  }

  async listRequisitions(p: Principal): Promise<JobRequisitionDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const reqs = await tx.jobRequisition.findMany({ orderBy: { createdAt: "desc" } });
      if (reqs.length === 0) return [];
      // Batch the applicant counts in ONE groupBy (not one count per requisition).
      const counts = await tx.applicant.groupBy({
        by: ["requisitionId"],
        where: { requisitionId: { in: reqs.map((r) => r.id) } },
        _count: { _all: true },
      });
      const byReq = new Map(counts.map((c) => [c.requisitionId, c._count._all]));
      return reqs.map((r) => this.reqDto(r, byReq.get(r.id) ?? 0));
    });
  }

  // --- applicants ------------------------------------------------------------
  async addApplicant(
    p: Principal,
    requisitionId: string,
    input: { name: string; email: string; phone?: string | null; notes?: string | null },
  ): Promise<ApplicantDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const req = await tx.jobRequisition.findFirst({ where: { id: requisitionId } });
      if (!req) throw new NotFoundException("Requisition not found");
      const a = await tx.applicant.create({
        data: { schoolId: p.schoolId, requisitionId, name: input.name, email: input.email, phone: input.phone ?? null, notes: input.notes ?? null, stage: "APPLIED", createdById: p.userId },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.recruit.applicant.add", entity: "applicant", entityId: a.id, schoolId: p.schoolId },
        tx,
      );
      return this.applicantDto(a);
    });
  }

  async listApplicants(p: Principal, requisitionId?: string): Promise<ApplicantDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.applicant.findMany({ where: requisitionId ? { requisitionId } : {}, orderBy: { createdAt: "desc" } });
      return rows.map((a) => this.applicantDto(a));
    });
  }

  async moveStage(p: Principal, applicantId: string, stage: string): Promise<ApplicantDto> {
    if (!STAGES.includes(stage)) throw new BadRequestException("invalid stage");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.applicant.findFirst({ where: { id: applicantId } });
      if (!a) throw new NotFoundException("Applicant not found");
      const updated = await tx.applicant.update({ where: { id: applicantId }, data: { stage } });
      await this.audit.record(
        { actorId: p.userId, action: "hr.recruit.applicant.stage", entity: "applicant", entityId: applicantId, schoolId: p.schoolId, metadata: { stage } },
        tx,
      );
      return this.applicantDto(updated);
    });
  }

  /** Convert a hired applicant into a User + Employee in this tenant. One-time creds. */
  async convert(
    p: Principal,
    applicantId: string,
    input: { jobTitle?: string; password?: string },
  ): Promise<{ userId: string; email: string; tempPassword: string }> {
    const tempPassword = input.password ?? crypto.randomBytes(9).toString("base64url");
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.applicant.findFirst({ where: { id: applicantId } });
      if (!a) throw new NotFoundException("Applicant not found");
      if (a.convertedUserId) throw new BadRequestException("Applicant already converted");
      // Same-school fast check; the create below is the authoritative guard since
      // user.email is GLOBALLY unique but this RLS-scoped read only sees THIS school.
      if (await tx.user.findFirst({ where: { email: a.email }, select: { id: true } })) {
        throw new ConflictException("A user with that email already exists");
      }
      const req = await tx.jobRequisition.findFirst({ where: { id: a.requisitionId }, select: { title: true } });
      let user: { id: string };
      try {
        user = await tx.user.create({ data: { schoolId: p.schoolId, email: a.email, name: a.name, passwordHash } });
      } catch (e) {
        // P2002 = unique violation: the email belongs to a user in ANOTHER school
        // (invisible to the RLS-scoped check above). Surface a clean 409, not a 500.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new ConflictException("That email is already in use");
        }
        throw e;
      }
      await tx.employee.create({
        data: { schoolId: p.schoolId, userId: user.id, jobTitle: input.jobTitle ?? req?.title ?? "Staff", startDate: new Date(), status: "ACTIVE" },
      });
      await tx.applicant.update({ where: { id: applicantId }, data: { stage: "HIRED", convertedUserId: user.id } });
      await this.audit.record(
        { actorId: p.userId, action: "hr.recruit.convert", entity: "applicant", entityId: applicantId, schoolId: p.schoolId, metadata: { userId: user.id } },
        tx,
      );
      return { userId: user.id, email: a.email, tempPassword };
    });
  }

  // --- PUBLIC careers surface (mirrors the /apply admissions pattern) --------
  /** PUBLIC: a school's OPEN vacancies by slug. No auth, no PII — title/
   *  department/description only. School resolved via the RLS-exempt registry. */
  async publicOpenings(
    slug: string,
  ): Promise<{ school: string; jobs: { id: string; title: string; department: string | null; description: string | null; openings: number }[] }> {
    const school = await this.db.runAsTenant<{ id: string; name: string } | null>(
      { schoolId: ZERO, userId: ZERO },
      (tx) => tx.school.findFirst({ where: { slug, status: "ACTIVE", isPlatform: false }, select: { id: true, name: true } }),
    );
    if (!school) throw new NotFoundException("School not found");
    const jobs = await this.db.runAsTenant({ schoolId: school.id, userId: ZERO }, (tx) =>
      tx.jobRequisition.findMany({
        where: { status: "OPEN" },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, department: true, description: true, openings: true },
      }),
    );
    return { school: school.name, jobs };
  }

  /** PUBLIC: apply to an OPEN vacancy. Quarantined intake exactly like the
   *  admissions portal: the applicant lands in the school's ATS pipeline
   *  (stage APPLIED) — never anywhere near staff or student data. One
   *  application per (email, requisition). */
  async publicApply(
    slug: string,
    input: { requisitionId: string; name: string; email: string; phone?: string; note?: string },
    cv?: { buffer: Buffer; originalname: string } | null,
  ): Promise<{ id: string; stage: string }> {
    const school = await this.db.runAsTenant<{ id: string } | null>(
      { schoolId: ZERO, userId: ZERO },
      (tx) => tx.school.findFirst({ where: { slug, status: "ACTIVE", isPlatform: false }, select: { id: true } }),
    );
    if (!school) throw new NotFoundException("School not found");
    // CV upload happens BEFORE the tx (storage isn't transactional); on any
    // application failure the object is deleted best-effort. PDF-only is
    // enforced by MAGIC BYTES, not the client's content-type claim.
    let cvKey: string | null = null;
    let cvName: string | null = null;
    if (cv) {
      if (cv.buffer.subarray(0, 5).toString() !== "%PDF-") {
        throw new BadRequestException("The CV must be a PDF file");
      }
      cvName = (cv.originalname || "cv.pdf").replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120);
      cvKey = `careers/${school.id}/${crypto.randomUUID()}.pdf`;
      await this.storage.upload({ key: cvKey, body: cv.buffer, contentType: "application/pdf" });
    }
    try {
      return await this.applyTx(school.id, input, cvKey, cvName);
    } catch (e) {
      if (cvKey) await this.storage.delete(cvKey).catch(() => undefined);
      throw e;
    }
  }

  private async applyTx(
    schoolId: string,
    input: { requisitionId: string; name: string; email: string; phone?: string; note?: string },
    cvKey: string | null,
    cvName: string | null,
  ): Promise<{ id: string; stage: string }> {
    const school = { id: schoolId };
    return this.db.runAsTenant({ schoolId: school.id, userId: ZERO }, async (tx) => {
      // Under this school's GUC a foreign requisitionId simply isn't found (404).
      const req = await tx.jobRequisition.findFirst({ where: { id: input.requisitionId }, select: { id: true, status: true } });
      if (!req || req.status !== "OPEN") throw new NotFoundException("This vacancy is not open");
      const email = input.email.trim().toLowerCase();
      const dup = await tx.applicant.findFirst({ where: { requisitionId: req.id, email }, select: { id: true } });
      if (dup) throw new ConflictException("You have already applied for this position");
      const row = await tx.applicant.create({
        data: {
          schoolId: school.id,
          requisitionId: req.id,
          name: input.name.trim(),
          email,
          phone: (input.phone ?? "").trim() || null,
          notes: (input.note ?? "").trim() || null,
          stage: "APPLIED",
          createdById: ZERO, // system actor: public intake
          cvKey,
          cvName,
        },
        select: { id: true, stage: true },
      });
      // No audit entry: audit_log.actorId FKs to a real user, and this is an
      // anonymous public intake (same as /public/admissions). The applicant row
      // itself (createdById = ZERO) IS the record of the submission.
      return row;
    });
  }

  /** Download an applicant's CV (hr.recruit.manage; audited — it's PII). */
  async downloadCv(p: Principal, applicantId: string): Promise<{ buffer: Buffer; filename: string }> {
    const meta = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.applicant.findFirst({ where: { id: applicantId }, select: { id: true, cvKey: true, cvName: true } });
      if (!a || !a.cvKey) throw new NotFoundException("No CV on this application");
      await this.audit.record(
        { actorId: p.userId, action: "hr.recruit.cv.download", entity: "applicant", entityId: a.id, schoolId: p.schoolId },
        tx,
      );
      return { cvKey: a.cvKey, cvName: a.cvName ?? "cv.pdf" };
    });
    const buffer = await this.storage.download(meta.cvKey);
    if (!buffer) throw new NotFoundException("CV file is no longer available");
    return { buffer, filename: meta.cvName };
  }

  // --- decorators ------------------------------------------------------------
  private reqDto(
    r: { id: string; title: string; department: string | null; description: string | null; status: string; openings: number; createdAt: Date },
    applicantCount: number,
  ): JobRequisitionDto {
    return { id: r.id, title: r.title, department: r.department, description: r.description, status: r.status, openings: r.openings, applicantCount, createdAt: r.createdAt };
  }

  private applicantDto(
    a: { id: string; requisitionId: string; name: string; email: string; phone: string | null; stage: string; notes: string | null; convertedUserId: string | null; cvName?: string | null; createdAt: Date },
  ): ApplicantDto {
    return { id: a.id, requisitionId: a.requisitionId, name: a.name, email: a.email, phone: a.phone, stage: a.stage, notes: a.notes, convertedUserId: a.convertedUserId, cvName: a.cvName ?? null, createdAt: a.createdAt };
  }
}
