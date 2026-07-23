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
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Prisma } from "@sms/db";
import { allocateLoginEmail, schoolSlugOf } from "../foundation/login-email";
import { formatAdmissionNumber, nextAdmissionSeq } from "@sms/types";
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

  /**
   * A blank CSV template with the SIS header row + two example rows.
   * The `email` column is OPTIONAL — the second example leaves it empty to show
   * that, since most pupils have no address and a sign-in identifier is
   * generated from the name.
   */
  csvTemplate(): string {
    const withEmail = ["Ada Lovelace", "ada@example.com", "ADM-001", "2012-05-01", "F", "08000000000", "12 Main St", ""];
    const noEmail = ["Bolu Eze", "", "ADM-002", "2012-09-14", "M", "", "", ""];
    return `${TEMPLATE_HEADERS.join(",")}\n${withEmail.join(",")}\n${noEmail.join(",")}\n`;
  }

  /** Stage a PENDING batch and compute a dry-run summary (new vs duplicate email). */
  async stage(p: Principal, rows: StudentImportRow[]) {
    if (!rows.length) throw new BadRequestException("No rows to import");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Only a SUPPLIED address can be a true duplicate now: a generated
      // identifier auto-suffixes, so a same-name row is always created. The dry
      // run therefore counts duplicates among supplied emails only (DB + repeats
      // within the file); generated rows are all "new".
      const suppliedEmails = rows
        .map((r) => r.email?.trim()?.toLowerCase())
        .filter((e): e is string => Boolean(e));
      const existing = await tx.user.findMany({
        where: { email: { in: suppliedEmails } },
        select: { email: true },
      });
      const dup = new Set(existing.map((e) => e.email.toLowerCase()));
      const seen = new Set<string>();
      let duplicateCount = 0;
      for (const e of suppliedEmails) {
        if (dup.has(e) || seen.has(e)) duplicateCount++;
        seen.add(e);
      }
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
    // PHASE 1 (read tx): validate the batch + SoD, load the rows.
    const rows = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const batch = (await tx.studentImportBatch.findFirst({ where: { id } })) as BatchRow | null;
      if (!batch) throw new NotFoundException("Import batch not found");
      if (batch.status !== "PENDING") throw new ConflictException("Batch already decided");
      // SECURITY: separation of duties — the approver cannot be the uploader.
      if (batch.uploadedById === p.userId) {
        throw new ForbiddenException("A different person must approve the import you uploaded");
      }
      return (batch.rows as StudentImportRow[] | null) ?? [];
    });

    // PHASE 2 (outside any tx — bcrypt is slow): a UNIQUE random temporary
    // password per row. // SECURITY: the old flow gave every imported student
    // the same well-known default, so any student could open any classmate's
    // portal until they all rotated. Now each account gets its own secret,
    // returned ONCE to the approver (never stored in plaintext), and
    // passwordChangedAt=null forces the student to set their own on first login.
    const prepared = await Promise.all(
      rows.map(async (row) => {
        const tempPassword = crypto.randomBytes(9).toString("base64url");
        return { row, tempPassword, passwordHash: await bcrypt.hash(tempPassword, 10) };
      }),
    );
    const credentials: { name: string; email: string; tempPassword: string; admissionNumber: string }[] = [];

    // PHASE 3 (write tx): CLAIM the batch (guarded flip — a concurrent approver
    // matches 0 rows), then create accounts with the precomputed hashes.
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const claimed = await tx.studentImportBatch.updateMany({
        where: { id, status: "PENDING" },
        data: { reviewedById: p.userId },
      });
      if (claimed.count === 0) throw new ConflictException("Batch already decided");
      const studentRole = await tx.role.findFirst({ where: { name: "student" }, select: { id: true } });
      if (!studentRole) throw new NotFoundException("student role missing");
      // Existing admission numbers in this tenant + ones seen earlier in the batch:
      // a duplicate admission number is skipped (it must be unique per school).
      const existingProfiles = await tx.studentProfile.findMany({
        where: { admissionNumber: { not: null } },
        select: { admissionNumber: true },
      });
      const usedAdmNo = new Set(existingProfiles.map((pr) => pr.admissionNumber).filter(Boolean) as string[]);
      // AUTO-GENERATE an admission number for any row that leaves it blank, so
      // every onboarded student has the reliable key used for parent linking.
      // Sequential within the school as <year>/NNNN; a school's own numbers are
      // honoured and just occupy the used-set.
      const admissionYear = new Date().getFullYear();
      let nextAdmSeq = nextAdmissionSeq(usedAdmNo, admissionYear);
      const allocateAdmissionNumber = (): string => {
        let candidate = formatAdmissionNumber(admissionYear, nextAdmSeq);
        while (usedAdmNo.has(candidate)) {
          nextAdmSeq += 1;
          candidate = formatAdmissionNumber(admissionYear, nextAdmSeq);
        }
        nextAdmSeq += 1;
        return candidate;
      };
      // Per-target-class capacity headroom, computed lazily.
      const headroom = new Map<string, number | null>(); // classId -> remaining (null = unlimited)
      let created = 0;
      let skipped = 0;
      const errors: string[] = [];
      // The school's domain, resolved once for the whole batch.
      const slug = await schoolSlugOf(tx, p.schoolId);
      // Identifiers issued EARLIER IN THIS TRANSACTION but not yet committed —
      // without this, one CSV containing two pupils called Adams James would
      // hand both the same identifier and the second INSERT would fail.
      const issued = new Set<string>();

      for (const { row, tempPassword, passwordHash } of prepared) {
        try {
          const generated = !row.email?.trim();
          let loginEmail: string;
          if (generated) {
            // Students auto-suffix a shared name (adams.james, adams.james2, ...),
            // checking BOTH the DB and identifiers issued earlier in this same tx,
            // so two "Adams James" in one file both import.
            loginEmail = await allocateLoginEmail(tx, row.name, slug, { taken: issued, autoSuffix: true });
          } else {
            loginEmail = row.email!.trim().toLowerCase();
            if (issued.has(loginEmail)) {
              errors.push(`${row.name}: another row in this file already uses ${loginEmail}`);
              skipped++;
              continue;
            }
            const existing = await tx.user.findFirst({ where: { email: loginEmail }, select: { id: true } });
            if (existing) {
              skipped++;
              continue;
            }
            issued.add(loginEmail);
          }
          const providedAdm = row.admissionNumber?.trim() || null;
          if (providedAdm && usedAdmNo.has(providedAdm)) {
            skipped++; // a SUPPLIED admission number that is already taken
            continue;
          }
          // Blank => generate; supplied => honour it. Either way, reserve it.
          const admissionNumber = providedAdm ?? allocateAdmissionNumber();
          usedAdmNo.add(admissionNumber);
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
            // passwordChangedAt: null => the login flow treats the password as
            // expired, forcing the student to set their own at first sign-in.
            data: {
              schoolId: p.schoolId,
              email: loginEmail,
              // Students are exempt from a contact address — guardians are notified.
              loginEmailGenerated: generated,
              name: row.name,
              passwordHash,
              passwordChangedAt: null,
            },
          });
          // The login slip must carry the identifier ACTUALLY issued, or the
          // student cannot sign in with what they were handed.
          credentials.push({ name: row.name, email: loginEmail, tempPassword, admissionNumber });
          await tx.userRole.create({ data: { schoolId: p.schoolId, userId: u.id, roleId: studentRole.id } });
          await tx.studentProfile.create({
            data: {
              schoolId: p.schoolId,
              studentId: u.id,
              admissionNumber,
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
          created++;
        } catch (err) {
          // A cross-school email collision surfaces here as a raw P2002. Translate
          // it — "Unique constraint failed on the fields: (`email`)" tells the
          // school administrator nothing they can act on.
          const msg =
            err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
              ? "that sign-in identifier is already taken — give this person a fuller name"
              : String(err).slice(0, 80);
          errors.push(`${row.name}: ${msg}`);
        }
      }
      const summary: StudentImportSummary = {
        total: prepared.length,
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
      // credentials ride ONLY on this response (shown once; never persisted).
      return { ...this.toDto(updated as unknown as BatchRow), credentials };
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
