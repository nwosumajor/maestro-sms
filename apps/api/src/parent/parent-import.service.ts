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
import { IS_STUDENT_ROLE_ROW } from "../common/student-scope";
import { Prisma } from "@sms/db";
import type {
  CreateParentResultDto,
  ParentCredential,
  ParentImportBatchDto,
  ParentImportRow,
  ParentImportSummary,
} from "@sms/types";
import { MAX_GUARDIANS_PER_STUDENT } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const TEMPLATE_HEADERS = ["name", "contactEmail", "phone", "studentAdmissionNumbers", "studentEmails", "relationship"];

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
  /**
   * Of the given user ids, the ones that actually hold the STUDENT role.
   *
   * ONE query, because the bulk path runs this per row over a file that can be
   * hundreds long.
   */
  private async studentIdsAmong(tx: TenantTx, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = (await tx.userRole.findMany({
      where: { userId: { in: ids }, ...IS_STUDENT_ROLE_ROW },
      select: { userId: true },
    })) as Array<{ userId: string }>;
    return new Set(rows.map((r) => r.userId));
  }

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
      // A student's `email` is now a GENERATED login the school does not know, so
      // also match on `contactEmail` (a real address, where one was set). Admission
      // number stays the reliable key — see the template.
      const wanted = emails.map((e) => e.toLowerCase());
      const users = await tx.user.findMany({
        where: { OR: [{ email: { in: wanted } }, { contactEmail: { in: wanted } }] },
        select: { id: true, email: true, contactEmail: true },
      });
      const byEmail = new Map<string, string>();
      for (const u of users) {
        byEmail.set(u.email.toLowerCase(), u.id);
        if (u.contactEmail) byEmail.set(u.contactEmail.toLowerCase(), u.id);
      }
      // ONLY A PUPIL. The admission-number branch above reads `studentProfile`,
      // which by construction only exists for a student; this one read `user`
      // and matched ANYBODY in the school — so a staff or guardian address in
      // the `studentEmails` column produced a ParentChild row pointing at a
      // member of staff, and the import reported it as a clean success.
      // Measured live: `{"linked":1,"errors":0,"unmatchedStudents":0}` for a row
      // whose "child" was Demo Teacher.
      const pupils = await this.studentIdsAmong(tx, [...new Set(byEmail.values())]);
      for (const em of emails) {
        const uid = byEmail.get(em.toLowerCase());
        // A non-pupil counts as UNMATCHED, not as a link. That is the honest
        // report — the office asked to attach a guardian to a child and no
        // child of that description was found — and it is what puts the row in
        // front of somebody instead of silently attaching the wrong person.
        if (uid && pupils.has(uid)) { ids.add(uid); matched++; }
      }
    }
    const totalRefs = admissionNumbers.length + emails.length;
    return { studentIds: [...ids], unmatched: totalRefs - matched };
  }

  /**
   * Idempotently create a ParentChild link (unique on parentId+studentId).
   *
   * Bounded by MAX_GUARDIANS_PER_STUDENT like the manual link, and for this path
   * above all: a spreadsheet with a repeated admission number, or a column
   * mapped to the wrong field, is exactly how one pupil ends up with forty
   * adults attached — each of them holding an access grant to that child's
   * records. Nobody re-reads a 900-row import.
   *
   * Throws rather than returning false, because the caller already turns a
   * ConflictException into a per-row error line and carries on with the rest of
   * the file. A silent skip would land in the `linked` count as if nothing had
   * happened, and the office would never learn the link it asked for was not
   * made — which is the same silent-success failure this codebase keeps finding.
   */
  private async link(
    tx: TenantTx,
    schoolId: string,
    parentId: string,
    studentId: string,
    relationship: string | null,
  ): Promise<boolean> {
    // THE BACKSTOP, and it is the KIND of thing being attached, not the count.
    //
    // This method's own comment reasons about "a column mapped to the wrong
    // field" and then bounds only how MANY guardians a pupil may have. The
    // manual link path in LmsService refuses a non-student by name ("X is not a
    // student") and checks the guardian's role too; neither path here did.
    // `parent_child` IS the family-scope access table, so a row in it that is
    // not guardian-of-a-pupil is corrupt authorization data.
    // The name is read LAZILY, only to word a refusal — the happy path of a
    // 900-row import must not pay an extra lookup per row for a message nobody
    // will see.
    if (!(await this.studentIdsAmong(tx, [studentId])).has(studentId)) {
      const who = (await tx.user.findFirst({
        where: { id: studentId },
        select: { name: true },
      })) as { name: string } | null;
      throw new ConflictException(`${who?.name ?? "That person"} is not a student`);
    }

    const existing = (await tx.parentChild.findMany({
      where: { studentId },
      select: { parentId: true },
    })) as Array<{ parentId: string }>;
    if (existing.some((l) => l.parentId === parentId)) return false;
    if (existing.length >= MAX_GUARDIANS_PER_STUDENT) {
      const pupil = (await tx.user.findFirst({
        where: { id: studentId },
        select: { name: true },
      })) as { name: string } | null;
      throw new ConflictException(
        `${pupil?.name ?? "that pupil"} already has the maximum of ${MAX_GUARDIANS_PER_STUDENT} linked guardians`,
      );
    }
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
        select: { id: true, name: true, email: true },
      });
      if (!parent) {
        // A guardian with children at ANOTHER school already has an account
        // there; this school gets its own, with the same real address for mail.
        // Generated identifier => the two can never collide across schools.
        // Auto-suffix a same-name clash (adams.james2) like the bulk path — every
        // parent path behaves the same.
        const slug = await schoolSlugOf(tx, p.schoolId);
        const loginEmail = await allocateLoginEmail(tx, input.name.trim(), slug, { autoSuffix: true });
        try {
          parent = await tx.user.create({
            data: {
              schoolId: p.schoolId,
              email: loginEmail,
              contactEmail: email,
              loginEmailGenerated: true,
              name: input.name.trim(),
              passwordHash,
              passwordChangedAt: null,
            },
            select: { id: true, name: true, email: true },
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
        // The generated SIGN-IN identifier — what the guardian logs in with and
        // what the slip shows. NOT `email` (their contact address, matched above).
        email: parent.email,
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
      const addresses = rows.map((r) => r.contactEmail.toLowerCase());
      // A guardian already on the platform is matched by their REAL address —
      // stored as contactEmail now, or as the legacy login email for accounts
      // created before generated identifiers. Those rows REUSE the account.
      const existing = await tx.user.findMany({
        where: { OR: [{ contactEmail: { in: addresses } }, { email: { in: addresses } }] },
        select: { email: true, contactEmail: true },
      });
      const known = new Set<string>();
      for (const u of existing) {
        if (u.contactEmail) known.add(u.contactEmail.toLowerCase());
        known.add(u.email.toLowerCase());
      }
      // A "duplicate" here = a guardian who ALREADY exists (matched by their real
      // address) OR the same address repeated within this file — both REUSE the
      // one account rather than creating a second. Track within-file repeats too,
      // or the preview over-counts "new".
      const seen = new Set<string>();
      let duplicateCount = 0;
      for (const e of addresses) {
        if (known.has(e) || seen.has(e)) duplicateCount++;
        seen.add(e);
      }
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
      // Open ones in full, then recent history — see StudentImportService.list.
      tx.parentImportBatch
        .findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 500 })
        .then(async (open) => [
          ...open,
          ...(await tx.parentImportBatch.findMany({
            where: { status: { not: "PENDING" } },
            orderBy: { createdAt: "desc" },
            take: 100,
          })),
        ]),
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

      const slug = await schoolSlugOf(tx, p.schoolId);
      const issued = new Set<string>();
      for (const { row, tempPassword, passwordHash } of prepared) {
        try {
          const contactEmail = row.contactEmail.trim().toLowerCase();
          // Match an existing guardian by their REAL address (contactEmail), with
          // the legacy login email as a fallback for pre-model accounts.
          let parent = await tx.user.findFirst({
            where: { OR: [{ contactEmail }, { email: contactEmail }] },
            select: { id: true },
          });
          if (!parent) {
            // New guardian: GENERATED login identifier, real address in
            // contactEmail. AUTO-SUFFIX like bulk student import — two unrelated
            // families sharing a name (different contactEmail, so no match above)
            // is common on a roll, and refusing one row would force a re-upload.
            // A guardian appearing twice with the SAME address was already matched
            // and reused above, so this only ever suffixes genuinely different
            // people. So a parent with children at two schools imports at both.
            const loginEmail = await allocateLoginEmail(tx, row.name.trim(), slug, {
              taken: issued,
              autoSuffix: true,
            });
            parent = await tx.user.create({
              data: {
                schoolId: p.schoolId,
                email: loginEmail,
                contactEmail,
                loginEmailGenerated: true,
                name: row.name.trim(),
                passwordHash,
                passwordChangedAt: null,
              },
              select: { id: true },
            });
            await tx.userRole.create({ data: { schoolId: p.schoolId, userId: parent.id, roleId: parentRole.id } });
            credentials.push({ name: row.name.trim(), email: loginEmail, tempPassword });
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
          // A same-name clash (ConflictException) or a cross-school address
          // collision (P2002) surfaces here as an actionable per-row error.
          const msg =
            err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
              ? "that email already belongs to an account on the platform — use a different address for this school"
              : err instanceof ConflictException
                ? err.message
                : String(err).slice(0, 80);
          errors.push(`${row.name}: ${msg}`);
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
