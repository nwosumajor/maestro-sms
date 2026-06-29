// =============================================================================
// StudentImportService — bulk SIS upload with maker-checker
// =============================================================================
// The uploader STAGES a batch of parsed SIS rows (status PENDING) — NOTHING is
// created yet. A DIFFERENT authorized person (separation of duties) approves,
// which in ONE tenant transaction creates each student User + student role +
// StudentProfile (+ enrollment if a classId is given), idempotent on email, then
// flips the batch APPROVED with a result summary. Reject discards the staged rows.
// Tenant-scoped (RLS), every action audited. Mirrors the maker-checker pattern
// used for admissions/payments.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import bcrypt from "bcryptjs";
import { Prisma } from "@sms/db";
import type {
  StudentImportBatchDto,
  StudentImportRow,
  StudentImportSummary,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const TEMPLATE_HEADERS = [
  "name",
  "email",
  "admissionNumber",
  "dateOfBirth",
  "gender",
  "phone",
  "address",
  "classId",
];

interface BatchRow {
  id: string;
  status: string;
  uploadedById: string;
  reviewedById: string | null;
  rows: unknown;
  summary: unknown;
  reviewNote: string | null;
  createdAt: Date;
}

@Injectable()
export class StudentImportService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** A blank CSV template with the SIS header row + one example row. */
  csvTemplate(): string {
    const example = ["Ada Lovelace", "ada@example.com", "ADM-001", "2012-05-01", "F", "08000000000", "12 Main St", ""];
    return `${TEMPLATE_HEADERS.join(",")}\n${example.join(",")}\n`;
  }

  /** Stage a PENDING batch and compute a dry-run summary (new vs duplicate email). */
  async stage(p: Principal, rows: StudentImportRow[]) {
    if (!rows.length) throw new BadRequestException("No rows to import");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const emails = rows.map((r) => r.email.toLowerCase());
      const existing = await tx.user.findMany({
        where: { email: { in: emails } },
        select: { email: true },
      });
      const dup = new Set(existing.map((e) => e.email.toLowerCase()));
      const duplicateCount = emails.filter((e) => dup.has(e)).length;
      const summary: StudentImportSummary = {
        total: rows.length,
        newCount: rows.length - duplicateCount,
        duplicateCount,
      };
      const batch = await tx.studentImportBatch.create({
        data: {
          schoolId: p.schoolId,
          status: "PENDING",
          uploadedById: p.userId,
          rows: rows as unknown as Prisma.InputJsonValue,
          summary: summary as unknown as Prisma.InputJsonValue,
        },
      });
      await this.log(tx, p, "student.import.stage", batch.id, { total: rows.length });
      return this.toDto(batch as unknown as BatchRow);
    });
  }

  async list(p: Principal): Promise<StudentImportBatchDto[]> {
    const rows = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.studentImportBatch.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    );
    return (rows as unknown as BatchRow[]).map((b) => this.toDto(b));
  }

  async get(p: Principal, id: string): Promise<StudentImportBatchDto> {
    const b = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.studentImportBatch.findFirst({ where: { id } }),
    );
    if (!b) throw new NotFoundException("Import batch not found");
    return this.toDto(b as unknown as BatchRow);
  }

  /** Approve a PENDING batch (SoD: a DIFFERENT person), creating the students. */
  async approve(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const batch = (await tx.studentImportBatch.findFirst({ where: { id } })) as BatchRow | null;
      if (!batch) throw new NotFoundException("Import batch not found");
      if (batch.status !== "PENDING") throw new ConflictException("Batch already decided");
      // SECURITY: separation of duties — the approver cannot be the uploader.
      if (batch.uploadedById === p.userId) {
        throw new ForbiddenException("A different person must approve the import you uploaded");
      }
      const studentRole = await tx.role.findFirst({ where: { name: "student" }, select: { id: true } });
      if (!studentRole) throw new NotFoundException("student role missing");

      const rows = (batch.rows as StudentImportRow[] | null) ?? [];
      const passwordHash = await bcrypt.hash("password123", 10); // temp; reset on first login
      // Existing admission numbers in this tenant + ones seen earlier in the batch:
      // a duplicate admission number is skipped (it must be unique per school).
      const existingProfiles = await tx.studentProfile.findMany({
        where: { admissionNumber: { not: null } },
        select: { admissionNumber: true },
      });
      const usedAdmNo = new Set(existingProfiles.map((pr) => pr.admissionNumber).filter(Boolean) as string[]);
      // Per-target-class capacity headroom, computed lazily.
      const headroom = new Map<string, number | null>(); // classId -> remaining (null = unlimited)
      let created = 0;
      let skipped = 0;
      const errors: string[] = [];
      for (const row of rows) {
        try {
          const existing = await tx.user.findFirst({ where: { email: row.email }, select: { id: true } });
          if (existing) {
            skipped++;
            continue;
          }
          if (row.admissionNumber && usedAdmNo.has(row.admissionNumber)) {
            skipped++; // duplicate admission number
            continue;
          }
          // Capacity guard for an enrolled row.
          if (row.classId) {
            if (!headroom.has(row.classId)) {
              const cls = await tx.class.findFirst({ where: { id: row.classId }, select: { capacity: true } });
              if (cls?.capacity == null) headroom.set(row.classId, null);
              else {
                const active = await tx.enrollment.count({ where: { classId: row.classId, status: "ACTIVE" } });
                headroom.set(row.classId, cls.capacity - active);
              }
            }
            const left = headroom.get(row.classId);
            if (left != null && left <= 0) {
              skipped++; // class full
              continue;
            }
          }
          const u = await tx.user.create({
            data: { schoolId: p.schoolId, email: row.email, name: row.name, passwordHash },
          });
          await tx.userRole.create({ data: { schoolId: p.schoolId, userId: u.id, roleId: studentRole.id } });
          await tx.studentProfile.create({
            data: {
              schoolId: p.schoolId,
              studentId: u.id,
              admissionNumber: row.admissionNumber ?? null,
              dateOfBirth: row.dateOfBirth ? new Date(row.dateOfBirth) : null,
              gender: row.gender ?? null,
              phone: row.phone ?? null,
              addressLine1: row.address ?? null,
            },
          });
          if (row.classId) {
            await tx.enrollment.create({ data: { schoolId: p.schoolId, classId: row.classId, studentId: u.id } });
            const left = headroom.get(row.classId);
            if (left != null) headroom.set(row.classId, left - 1);
          }
          if (row.admissionNumber) usedAdmNo.add(row.admissionNumber);
          created++;
        } catch (err) {
          errors.push(`${row.email}: ${String(err).slice(0, 80)}`);
        }
      }
      const summary: StudentImportSummary = {
        total: rows.length,
        newCount: created,
        duplicateCount: skipped,
        created,
        skipped,
        errors: errors.length,
      };
      const updated = await tx.studentImportBatch.update({
        where: { id },
        data: { status: "APPROVED", reviewedById: p.userId, summary: summary as unknown as Prisma.InputJsonValue },
      });
      await this.log(tx, p, "student.import.approve", id, { created, skipped, errors: errors.length });
      return this.toDto(updated as unknown as BatchRow);
    });
  }

  async reject(p: Principal, id: string, note?: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const batch = (await tx.studentImportBatch.findFirst({ where: { id } })) as BatchRow | null;
      if (!batch) throw new NotFoundException("Import batch not found");
      if (batch.status !== "PENDING") throw new ConflictException("Batch already decided");
      const updated = await tx.studentImportBatch.update({
        where: { id },
        data: { status: "REJECTED", reviewedById: p.userId, reviewNote: note ?? null },
      });
      await this.log(tx, p, "student.import.reject", id, {});
      return this.toDto(updated as unknown as BatchRow);
    });
  }

  // --- helpers ---------------------------------------------------------------
  private toDto(b: BatchRow): StudentImportBatchDto {
    const rows = (b.rows as StudentImportRow[] | null) ?? [];
    return {
      id: b.id,
      status: b.status,
      uploadedById: b.uploadedById,
      reviewedById: b.reviewedById,
      rowCount: rows.length,
      summary: (b.summary as StudentImportSummary | null) ?? null,
      reviewNote: b.reviewNote,
      createdAt: b.createdAt,
    };
  }

  private async log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { actorId: p.userId, action, entity: "student_import_batch", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
