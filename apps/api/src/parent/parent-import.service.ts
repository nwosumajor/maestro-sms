// =============================================================================
// ParentImportService — parent onboarding: single create + bulk maker-checker
// =============================================================================
// Parents get REAL accounts here (they previously could only be linked, never
// created). Both paths mint a UNIQUE one-time password (bcrypt-hashed; the
// plaintext is returned ONCE and never stored) with passwordChangedAt=null so
// the parent must set their own at first login — identical to the SIS student
// import. Children are referenced by admission number and/or email and resolved
// to ParentChild links in-tenant (RLS scopes the lookup; unmatched refs are
// reported, not fatal). Bulk upload is maker-checker (a DIFFERENT person
// approves). Every mutation audit-logged. Cross-tenant -> 404.
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
import { allocateLoginEmail, schoolSlugOf } from "../foundation/login-email";
import { Prisma } from "@sms/db";
import type {
  CreateParentResultDto,
  ParentCredential,
  ParentImportBatchDto,
  ParentImportRow,
  ParentImportSummary,
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

const TEMPLATE_HEADERS = ["name", "email", "phone", "studentAdmissionNumbers", "studentEmails", "relationship"];

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

/** Split a ";"/"," separated cell into trimmed non-empty tokens. */
function tokens(cell: string | null | undefined): string[] {
  if (!cell) return [];
  return cell
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

@Injectable()
export class ParentImportService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private newSecret(): string {
    return crypto.randomBytes(9).toString("base64url");
  }

  /** Resolve child references (admission numbers + emails) to in-tenant student
   *  ids. Returns the matched ids and how many refs matched nothing. */
  private async resolveChildren(
    tx: TenantTx,
    admissionNumbers: string[],
    emails: string[],
  ): Promise<{ studentIds: string[]; unmatched: number }> {
    const ids = new Set<string>();
    let matched = 0;
    if (admissionNumbers.length > 0) {
      const profiles = await tx.studentProfile.findMany({
        where: { admissionNumber: { in: admissionNumbers } },
        select: { studentId: true, admissionNumber: true },
      });
      const byAdm = new Map(profiles.map((pr) => [pr.admissionNumber, pr.studentId]));
      for (const adm of admissionNumbers) {
        const sid = byAdm.get(adm);
        if (sid) { ids.add(sid); matched++; }
      }
    }
    if (emails.length > 0) {
      const users = await tx.user.findMany({
        where: { email: { in: emails.map((e) => e.toLowerCase()) } },
        select: { id: true, email: true },
      });
      const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
      for (const em of emails) {
        const uid = byEmail.get(em.toLowerCase());
        if (uid) { ids.add(uid); matched++; }
      }
    }
    const totalRefs = admissionNumbers.length + emails.length;
    return { studentIds: [...ids], unmatched: totalRefs - matched };
  }

  /** Idempotently create a ParentChild link (unique on parentId+studentId). */
  private async link(
    tx: TenantTx,
    schoolId: string,
    parentId: string,
    studentId: string,
    relationship: string | null,
  ): Promise<boolean> {
    const existing = await tx.parentChild.findFirst({
      where: { parentId, studentId },
      select: { id: true },
    });
    if (existing) return false;
    await tx.parentChild.create({ data: { schoolId, parentId, studentId, relationship } });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Single-parent onboarding
  // ---------------------------------------------------------------------------
  /** Create ONE parent account (or reuse an existing email) and link them to the
   *  given students. Returns the one-time credential when a new account is made. */
  async createSingle(
    p: Principal,
    input: { name: string; email: string; phone?: string | null; studentIds?: string[]; relationship?: string | null },
  ): Promise<CreateParentResultDto> {
    const email = input.email.trim().toLowerCase();
    if (!email) throw new BadRequestException("email is required");
    const studentIds = [...new Set(input.studentIds ?? [])];

    // Hash outside the tx (bcrypt is slow) — only used if we create a new user.
    const tempPassword = this.newSecret();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const parentRole = await tx.role.findFirst({ where: { name: "parent" }, select: { id: true } });
      if (!parentRole) throw new NotFoundException("parent role missing");

      // Every provided student must exist in THIS tenant (RLS scopes the read).
      let validStudentIds: string[] = [];
      if (studentIds.length > 0) {
        const found = await tx.user.findMany({ where: { id: { in: studentIds } }, select: { id: true } });
        validStudentIds = found.map((u) => u.id);
        if (validStudentIds.length !== studentIds.length) {
          throw new BadRequestException("One or more students were not found in this school");
        }
      }

      let created = false;
      // Match on the REAL address (contactEmail) — that is what identifies a
      // guardian now that `email` is a generated, school-scoped login identifier.
      // The legacy `email` match stays as a fallback so guardians created before
      // this change are still found rather than duplicated.
      let parent = await tx.user.findFirst({
        where: { OR: [{ contactEmail: email }, { email }] },
        select: { id: true, name: true },
      });
      if (!parent) {
        // A guardian with children at ANOTHER school already has an account
        // there; this school gets its own, with the same real address for mail.
        // Generated identifier => the two can never collide.
        const slug = await schoolSlugOf(tx, p.schoolId);
        const loginEmail = await allocateLoginEmail(tx, input.name.trim(), slug);
        try {
          parent = await tx.user.create({
            data: {
              schoolId: p.schoolId,
              email: loginEmail,
              contactEmail: email,
              name: input.name.trim(),
              passwordHash,
              passwordChangedAt: null,
            },
            select: { id: true, name: true },
          });
        } catch (e) {
        // P2002 = unique violation on the GLOBAL user.email index: the address
        // belongs to a user in ANOTHER school, which the RLS-scoped check above
        // cannot see. Surface a clean conflict, not a 500. Deliberately does NOT
        // name the other school — that would leak cross-tenant existence.
          // Most likely collision in the whole system: one parent with children at
          // two different schools on the platform.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
            throw new ConflictException(
              "That email already belongs to an account on the platform. A guardian can only hold one account; ask them to use a different address for this school.",
            );
          }
          throw e;
        }
        await tx.userRole.create({ data: { schoolId: p.schoolId, userId: parent.id, roleId: parentRole.id } });
        created = true;
      } else {
        // Existing account: ensure it carries the parent role (idempotent).
        const hasRole = await tx.userRole.findFirst({
          where: { userId: parent.id, roleId: parentRole.id },
          select: { userId: true },
        });
        if (!hasRole) await tx.userRole.create({ data: { schoolId: p.schoolId, userId: parent.id, roleId: parentRole.id } });
      }

      const linkedStudentIds: string[] = [];
      for (const sid of validStudentIds) {
        if (await this.link(tx, p.schoolId, parent.id, sid, input.relationship ?? null)) {
          linkedStudentIds.push(sid);
        } else {
          linkedStudentIds.push(sid); // already linked — still "their child"
        }
      }

      await this.audit.record(
        {
          actorId: p.userId,
          action: "parent.onboard.single",
          entity: "user",
          entityId: parent.id,
          schoolId: p.schoolId,
          metadata: { created, linked: linkedStudentIds.length },
        },
        tx,
      );
      return {
        parentId: parent.id,
        name: parent.name,
        email,
        tempPassword: created ? tempPassword : null,
        created,
        linkedStudentIds,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Bulk upload (maker-checker)
  // ---------------------------------------------------------------------------
  csvTemplate(): string {
    const example = ["Grace Bassey", "grace@example.com", "08010000000", "ADM-001;ADM-014", "", "Mother"];
    return `${TEMPLATE_HEADERS.join(",")}\n${example.join(",")}\n`;
  }

  async stage(p: Principal, rows: ParentImportRow[]): Promise<ParentImportBatchDto> {
    if (!rows.length) throw new BadRequestException("No rows to import");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const emails = rows.map((r) => r.email.toLowerCase());
      const existing = await tx.user.findMany({ where: { email: { in: emails } }, select: { email: true } });
      const dup = new Set(existing.map((e) => e.email.toLowerCase()));
      const duplicateCount = emails.filter((e) => dup.has(e)).length;
      const summary: ParentImportSummary = {
        total: rows.length,
        newCount: rows.length - duplicateCount,
        duplicateCount,
      };
      const batch = await tx.parentImportBatch.create({
        data: {
          schoolId: p.schoolId,
          status: "PENDING",
          uploadedById: p.userId,
          rows: rows as unknown as Prisma.InputJsonValue,
          summary: summary as unknown as Prisma.InputJsonValue,
        },
      });
      await this.log(tx, p, "parent.import.stage", batch.id, { total: rows.length });
      return this.toDto(batch as unknown as BatchRow);
    });
  }

  async list(p: Principal): Promise<ParentImportBatchDto[]> {
    const rows = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.parentImportBatch.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    );
    return (rows as unknown as BatchRow[]).map((b) => this.toDto(b));
  }

  async get(p: Principal, id: string): Promise<ParentImportBatchDto> {
    const b = await this.db.runAsTenant(this.ctx(p), (tx) => tx.parentImportBatch.findFirst({ where: { id } }));
    if (!b) throw new NotFoundException("Import batch not found");
    return this.toDto(b as unknown as BatchRow);
  }

  /** Approve a PENDING batch (SoD: a DIFFERENT person), creating parents + links. */
  async approve(p: Principal, id: string): Promise<ParentImportBatchDto> {
    // PHASE 1 (read tx): validate batch + SoD, load rows.
    const rows = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const batch = (await tx.parentImportBatch.findFirst({ where: { id } })) as BatchRow | null;
      if (!batch) throw new NotFoundException("Import batch not found");
      if (batch.status !== "PENDING") throw new ConflictException("Batch already decided");
      if (batch.uploadedById === p.userId) {
        throw new ForbiddenException("A different person must approve the import you uploaded");
      }
      return (batch.rows as ParentImportRow[] | null) ?? [];
    });

    // PHASE 2 (outside tx — bcrypt is slow): a UNIQUE password per row.
    const prepared = await Promise.all(
      rows.map(async (row) => {
        const tempPassword = this.newSecret();
        return { row, tempPassword, passwordHash: await bcrypt.hash(tempPassword, 10) };
      }),
    );
    const credentials: ParentCredential[] = [];

    // PHASE 3 (write tx): claim the batch, then create accounts + links.
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const claimed = await tx.parentImportBatch.updateMany({
        where: { id, status: "PENDING" },
        data: { reviewedById: p.userId },
      });
      if (claimed.count === 0) throw new ConflictException("Batch already decided");
      const parentRole = await tx.role.findFirst({ where: { name: "parent" }, select: { id: true } });
      if (!parentRole) throw new NotFoundException("parent role missing");

      let created = 0;
      let reused = 0;
      let linked = 0;
      let unmatchedStudents = 0;
      const errors: string[] = [];

      for (const { row, tempPassword, passwordHash } of prepared) {
        try {
          const email = row.email.trim().toLowerCase();
          let parent = await tx.user.findFirst({ where: { email }, select: { id: true } });
          if (!parent) {
            parent = await tx.user.create({
              data: { schoolId: p.schoolId, email, name: row.name.trim(), passwordHash, passwordChangedAt: null },
              select: { id: true },
            });
            await tx.userRole.create({ data: { schoolId: p.schoolId, userId: parent.id, roleId: parentRole.id } });
            credentials.push({ name: row.name.trim(), email, tempPassword });
            created++;
          } else {
            const hasRole = await tx.userRole.findFirst({
              where: { userId: parent.id, roleId: parentRole.id },
              select: { userId: true },
            });
            if (!hasRole) await tx.userRole.create({ data: { schoolId: p.schoolId, userId: parent.id, roleId: parentRole.id } });
            reused++;
          }

          const { studentIds, unmatched } = await this.resolveChildren(
            tx,
            tokens(row.studentAdmissionNumbers),
            tokens(row.studentEmails),
          );
          unmatchedStudents += unmatched;
          for (const sid of studentIds) {
            if (await this.link(tx, p.schoolId, parent.id, sid, row.relationship ?? null)) linked++;
          }
        } catch (err) {
          errors.push(`${row.email}: ${String(err).slice(0, 80)}`);
        }
      }

      const summary: ParentImportSummary = {
        total: prepared.length,
        newCount: created,
        duplicateCount: reused,
        created,
        reused,
        linked,
        unmatchedStudents,
        errors: errors.length,
      };
      const updated = await tx.parentImportBatch.update({
        where: { id },
        data: { status: "APPROVED", reviewedById: p.userId, summary: summary as unknown as Prisma.InputJsonValue },
      });
      await this.log(tx, p, "parent.import.approve", id, { created, reused, linked, unmatchedStudents, errors: errors.length });
      return { ...this.toDto(updated as unknown as BatchRow), credentials };
    });
  }

  async reject(p: Principal, id: string, note?: string): Promise<ParentImportBatchDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const batch = (await tx.parentImportBatch.findFirst({ where: { id } })) as BatchRow | null;
      if (!batch) throw new NotFoundException("Import batch not found");
      if (batch.status !== "PENDING") throw new ConflictException("Batch already decided");
      const updated = await tx.parentImportBatch.update({
        where: { id },
        data: { status: "REJECTED", reviewedById: p.userId, reviewNote: note ?? null },
      });
      await this.log(tx, p, "parent.import.reject", id, {});
      return this.toDto(updated as unknown as BatchRow);
    });
  }

  // --- helpers ---------------------------------------------------------------
  private toDto(b: BatchRow): ParentImportBatchDto {
    const rows = (b.rows as ParentImportRow[] | null) ?? [];
    return {
      id: b.id,
      status: b.status,
      uploadedById: b.uploadedById,
      reviewedById: b.reviewedById,
      rowCount: rows.length,
      summary: (b.summary as ParentImportSummary | null) ?? null,
      reviewNote: b.reviewNote,
      createdAt: b.createdAt,
    };
  }

  private async log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { actorId: p.userId, action, entity: "parent_import_batch", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
