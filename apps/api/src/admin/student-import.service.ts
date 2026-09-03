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
import { hashEachWithoutBlocking } from "../foundation/bulk-hash";
import { Prisma } from "@sms/db";
import { schoolSlugOf } from "../foundation/login-email";
import { allocateAdmissionNumber } from "../foundation/admission-number";
import { BULK_IMPORT_MAX_ROWS, bulkImportTooLarge, generateLoginEmail } from "@sms/types";
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

/**
 * The template a school actually fills in.
 *
 * The class column used to be `classId` — a raw 36-character UUID, one per
 * pupil. Nobody has that. To fill in a spreadsheet you would have to dig an id
 * out of a URL for every class, paste it hundreds of times, and then be unable
 * to check your own work, because a column of uuids cannot be read back.
 *
 * It is now `class`, and it takes what the school already calls the class: its
 * NAME ("SS3 Science A") or its CODE. Both are unique per school and both are
 * visible on the classes page. A uuid still resolves, so any file somebody
 * already built keeps working.
 */
/** A value shaped like an id, so an already-built file still resolves. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TEMPLATE_HEADERS = [
  "name",
  "email",
  "admissionNumber",
  "dateOfBirth",
  "gender",
  "phone",
  "address",
  "class",
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

/** Bulk inserts are chunked so one enormous batch cannot exceed Postgres's
 *  parameter limit for a single statement. */
function chunked<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
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
    // The sample rows SHOW the class written the way a school writes it, so the
    // format is obvious from the file itself rather than from documentation
    // somebody has to be told exists.
    const withEmail = ["Ada Lovelace", "ada@example.com", "ADM-001", "2012-05-01", "F", "08000000000", "12 Main St", "SS3 Science A"];
    const noEmail = ["Bolu Eze", "", "ADM-002", "2012-09-14", "M", "", "", "JSS1"];
    return `${TEMPLATE_HEADERS.join(",")}\n${withEmail.join(",")}\n${noEmail.join(",")}\n`;
  }

  /**
   * Turn what a school typed in the `class` column into a class id.
   *
   * Accepts, in order: an exact id, the class CODE, or the class NAME
   * case-insensitively — because "ss3 science a" is what somebody will type and
   * refusing it teaches nothing. Returns null when it matches nothing, and the
   * CALLER reports which value failed: "no class called X" is actionable,
   * "invalid row" is not.
   */
  private async resolveClassRef(tx: TenantTx, ref: string): Promise<string | null> {
    const value = ref.trim();
    if (!value) return null;
    const found = (await tx.class.findFirst({
      where: {
        OR: [
          ...(UUID_RE.test(value) ? [{ id: value }] : []),
          { code: { equals: value, mode: "insensitive" as const } },
          { name: { equals: value, mode: "insensitive" as const } },
        ],
      },
      select: { id: true },
    })) as { id: string } | null;
    return found?.id ?? null;
  }

  /** Stage a PENDING batch and compute a dry-run summary (new vs duplicate email). */
  async stage(p: Principal, inputRows: StudentImportRow[]) {

    let rows = inputRows;
    if (rows.length > BULK_IMPORT_MAX_ROWS) throw new BadRequestException(bulkImportTooLarge("student", rows.length));
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
      // Resolve every class the file names, ONCE per distinct value rather than
      // once per pupil — a 300-row file usually names a handful of classes.
      const refs = [...new Set(rows.map((r) => (r.class ?? r.classId ?? "").trim()).filter(Boolean))];
      const resolved = new Map<string, string | null>();
      for (const ref of refs) resolved.set(ref, await this.resolveClassRef(tx, ref));
      const unknownClasses = refs.filter((r) => !resolved.get(r));

      // Write the resolved id onto the stored row, so approval does not have to
      // resolve again — and cannot resolve DIFFERENTLY if a class is renamed
      // between the dry run and the approval.
      rows = rows.map((r) => {
        const ref = (r.class ?? r.classId ?? "").trim();
        return ref ? { ...r, classId: resolved.get(ref) ?? null } : r;
      });

      const summary: StudentImportSummary = {
        total: rows.length,
        newCount: rows.length - duplicateCount,
        ...(unknownClasses.length ? { unknownClasses } : {}),
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
    // See PromotionService.list — a PENDING batch ages, and a newest-first cap
    // drops the oldest first, so the queue the screen computes in memory could
    // not see the batches that had waited longest. Every open one is returned.
    const rows = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const [open, recent] = await Promise.all([
        tx.studentImportBatch.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 500 }),
        tx.studentImportBatch.findMany({ where: { status: { not: "PENDING" } }, orderBy: { createdAt: "desc" }, take: 100 }),
      ]);
      return [...open, ...recent];
    });
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
    // SEQUENTIAL, yielding between hashes. `Promise.all` over bcryptjs starves
    // the event loop for the WHOLE batch — see foundation/bulk-hash.ts.
    const prepared = await hashEachWithoutBlocking(
      rows,
      () => crypto.randomBytes(9).toString("base64url"),
      (row, tempPassword, passwordHash) => ({ row, tempPassword, passwordHash }),
    );
    const credentials: { name: string; email: string; tempPassword: string; admissionNumber: string }[] = [];

    // PHASE 3a (batched reads): everything the row loop used to ask the database
    // for, asked ONCE. It used to run 5-6 sequential round trips PER ROW inside
    // ONE interactive transaction, which Prisma caps at 5 SECONDS — so a school
    // importing its roll on day one got "Internal server error", and whether it
    // worked depended on how many pupils and how busy the task was. Measured:
    // 25 rows 2.2 s, 50 rows 4.6 s, 200 rows 37 s on an IDLE stack, and 20 rows
    // FAILED with four schools importing at once. The schema permits 1,000.
    const ctxRead = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const studentRole = await tx.role.findFirst({ where: { name: "student" }, select: { id: true } });
      if (!studentRole) throw new NotFoundException("student role missing");
      const slug = await schoolSlugOf(tx, p.schoolId);
      const existingProfiles = await tx.studentProfile.findMany({
        where: { admissionNumber: { not: null } },
        select: { admissionNumber: true },
      });
      // Capacity headroom for every class named in the batch: two queries, not
      // two PER CLASS.
      const classIds = [...new Set(prepared.map((x) => x.row.classId).filter(Boolean) as string[])];
      const classes = classIds.length
        ? await tx.class.findMany({ where: { id: { in: classIds } }, select: { id: true, capacity: true } })
        : [];
      const counts = classIds.length
        ? await tx.enrollment.groupBy({ by: ["classId"], where: { classId: { in: classIds }, status: "ACTIVE" }, _count: { _all: true } })
        : [];
      return { studentRole, slug, existingProfiles, classes, counts };
    });
    const usedAdmNo = new Set(
      ctxRead.existingProfiles.map((pr) => pr.admissionNumber).filter(Boolean) as string[],
    );
    const activeBy = new Map(ctxRead.counts.map((c) => [c.classId, c._count._all]));
    const headroom = new Map<string, number | null>(
      ctxRead.classes.map((c) => [c.id, c.capacity == null ? null : c.capacity - (activeBy.get(c.id) ?? 0)]),
    );

    // Which sign-in identifiers are already taken. The auto-suffix allocator used
    // to ask the database once PER CANDIDATE; the candidates are generated by a
    // PURE function, so the whole window can be asked in ONE query. The window is
    // widened and re-asked only if a name genuinely exhausts it — which needs more
    // identically-named pupils than the batch itself contains.
    const takenEmails = new Set<string>();
    const supplied = prepared
      .map((x) => x.row.email?.trim().toLowerCase())
      .filter(Boolean) as string[];
    // base identifier -> how many rows in THIS batch want it, and one sample
    // name so the pure generator can be re-run for any suffix.
    const perBase = new Map<string, { need: number; name: string }>();
    for (const { row } of prepared) {
      if (row.email?.trim()) continue;
      const base = generateLoginEmail(row.name, ctxRead.slug, 0);
      const e = perBase.get(base);
      if (e) e.need += 1;
      else perBase.set(base, { need: 1, name: row.name });
    }
    let window = 8;
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidates = new Set<string>(supplied);
      for (const { need, name } of perBase.values())
        for (let sfx = 0; sfx <= need + window; sfx++)
          candidates.add(generateLoginEmail(name, ctxRead.slug, sfx));
      const found = candidates.size
        ? await this.db.runAsTenant(this.ctx(p), (tx) =>
            tx.user.findMany({ where: { email: { in: [...candidates] } }, select: { email: true } }),
          )
        : [];
      takenEmails.clear();
      for (const u of found) takenEmails.add(u.email);
      // Widen only if a name genuinely cannot be allocated inside its window —
      // which needs MORE identically-named pupils already on roll than this batch
      // contains. Bounded, so a pathological roll cannot loop for ever.
      const short = [...perBase.values()].some(({ need, name }) => {
        let free = 0;
        for (let sfx = 0; sfx <= need + window && free < need; sfx++)
          if (!takenEmails.has(generateLoginEmail(name, ctxRead.slug, sfx))) free += 1;
        return free < need;
      });
      if (!short) break;
      window *= 4;
    }

    // PHASE 3b (pure): decide every row IN MEMORY. No database call in this loop,
    // which is the whole point — the rules are unchanged, the round trips are gone.
    const admissionYear = new Date().getFullYear();
    const issued = new Set<string>(takenEmails);
    const newUsers: Prisma.UserCreateManyInput[] = [];
    const newRoles: Prisma.UserRoleCreateManyInput[] = [];
    const newProfiles: Prisma.StudentProfileCreateManyInput[] = [];
    const newEnrolments: Prisma.EnrollmentCreateManyInput[] = [];
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const { row, tempPassword, passwordHash } of prepared) {
      const generated = !row.email?.trim();
      let loginEmail: string;
      if (generated) {
        // Students auto-suffix a shared name (adams.james, adams.james2, ...),
        // against BOTH what the school already holds and what this batch has
        // issued, so two "Adams James" in one file both import.
        let allocated: string | null = null;
        for (let sfx = 0; sfx <= 500; sfx++) {
          const candidate = generateLoginEmail(row.name, ctxRead.slug, sfx);
          if (!issued.has(candidate)) { allocated = candidate; break; }
        }
        if (!allocated) {
          errors.push(`${row.name}: could not allocate a sign-in identifier`);
          skipped++;
          continue;
        }
        loginEmail = allocated;
      } else {
        loginEmail = row.email!.trim().toLowerCase();
        if (issued.has(loginEmail)) {
          if (takenEmails.has(loginEmail)) { skipped++; continue; }
          errors.push(`${row.name}: another row in this file already uses ${loginEmail}`);
          skipped++;
          continue;
        }
      }
      issued.add(loginEmail);
      const providedAdm = row.admissionNumber?.trim() || null;
      if (providedAdm && usedAdmNo.has(providedAdm)) {
        skipped++; // a SUPPLIED admission number that is already taken
        continue;
      }
      const admissionNumber = providedAdm ?? allocateAdmissionNumber(usedAdmNo, admissionYear);
      usedAdmNo.add(admissionNumber);
      if (row.classId) {
        const left = headroom.get(row.classId);
        if (left != null && left <= 0) { skipped++; continue; } // class full
      }
      const userId = crypto.randomUUID();
      newUsers.push({
        id: userId,
        schoolId: p.schoolId,
        email: loginEmail,
        // Students are exempt from a contact address — guardians are notified.
        loginEmailGenerated: generated,
        name: row.name,
        passwordHash,
        // passwordChangedAt: null => the login flow treats the password as
        // expired, forcing the student to set their own at first sign-in.
        passwordChangedAt: null,
      });
      newRoles.push({ schoolId: p.schoolId, userId, roleId: ctxRead.studentRole.id });
      newProfiles.push({
        schoolId: p.schoolId,
        studentId: userId,
        admissionNumber,
        dateOfBirth: row.dateOfBirth ? new Date(row.dateOfBirth) : null,
        gender: row.gender ?? null,
        phone: row.phone ?? null,
        addressLine1: row.address ?? null,
      });
      if (row.classId) {
        newEnrolments.push({ schoolId: p.schoolId, classId: row.classId, studentId: userId });
        const left = headroom.get(row.classId);
        if (left != null) headroom.set(row.classId, left - 1);
      }
      // The login slip must carry the identifier ACTUALLY issued, or the student
      // cannot sign in with what they were handed.
      credentials.push({ name: row.name, email: loginEmail, tempPassword, admissionNumber });
      created++;
    }

    // PHASE 3c (write tx): CLAIM the batch (guarded flip — a concurrent approver
    // matches 0 rows), then four bulk inserts. Milliseconds, whatever the size.
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const claimed = await tx.studentImportBatch.updateMany({
        where: { id, status: "PENDING" },
        data: { reviewedById: p.userId },
      });
      if (claimed.count === 0) throw new ConflictException("Batch already decided");
      try {
        for (const chunk of chunked(newUsers, 500)) await tx.user.createMany({ data: chunk });
        for (const chunk of chunked(newRoles, 500)) await tx.userRole.createMany({ data: chunk });
        for (const chunk of chunked(newProfiles, 500)) await tx.studentProfile.createMany({ data: chunk });
        for (const chunk of chunked(newEnrolments, 500)) await tx.enrollment.createMany({ data: chunk });
      } catch (err) {
        // A pre-check cannot beat a concurrent import, and P2002 is the final
        // guarantee — the same reasoning login-email.ts records. Nothing is
        // written (the tx rolls back), and the approver is told what to do
        // rather than being handed "Internal server error".
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new ConflictException(
            "Somebody else created a student with one of these sign-in identifiers while this import was being approved. " +
              "Nothing was imported — approve it again.",
          );
        }
        throw err as Error;
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
