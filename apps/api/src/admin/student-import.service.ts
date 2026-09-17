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
import {
  BULK_IMPORT_MAX_ROWS,
  bulkImportTooLarge,
  csvCellOf,
  generateLoginEmail,
  SIS_IMPORT_COLUMNS,
  SIS_IMPORT_HEADERS,
  STUDENT_IMPORT_UPDATE_PREVIEW,
} from "@sms/types";
import type {
  StudentImportBatchDto,
  StudentImportRow,
  StudentImportSummary,
  StudentImportUpdatePreview,
} from "@sms/types";
import { assertClassCapacity } from "../common/class-capacity";
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
 * The template a school actually fills in — defined ONCE, in `@sms/types`.
 *
 * It lived here AND in `SisImport.tsx` as two hand-kept arrays. The file is
 * parsed by HEADER NAME, so drift between them is not a crash: it is a column a
 * school fills in and the platform silently drops. `SIS_IMPORT_COLUMNS` is the
 * one definition and both sides read it.
 *
 * The class column used to be `classId` — a raw 36-character UUID, one per
 * pupil. Nobody has that. It is now `class`, taking what the school already
 * calls the class: its NAME ("SS3 Science A") or its CODE. Both are unique per
 * school and both are visible on the classes page. A uuid still resolves, so any
 * file somebody already built keeps working.
 */
/** A value shaped like an id, so an already-built file still resolves. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stored values an update is compared against and written over. */
interface ExistingProfile {
  id: string;
  studentId: string;
  admissionNumber: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
}

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
   * A blank CSV template: the header row + two example rows.
   *
   * The examples are the documentation. They show the class written the way a
   * school writes it, and they show which columns may be left blank — the second
   * pupil has no email (a sign-in identifier is generated from the name) and no
   * address, so the family will be asked for it.
   *
   * THE FIRST EXAMPLE IS DELIBERATELY COMPLETE, because a school that copies it
   * produces profiles that need no chasing at all. The old template could not
   * express that: it had no `city` or `state` column, so even a perfectly filled
   * file left every pupil INCOMPLETE and nudged nightly.
   *
   * Every cell is quoted through `csvCellOf`, because the address is the field
   * most likely to contain a comma and the template must be readable by the
   * parser it ships with.
   */
  csvTemplate(): string {
    const filled: Record<string, string> = {
      name: "Ada Lovelace",
      admissionNumber: "ADM-001",
      class: "SS3 Science A",
      dateOfBirth: "2012-05-01",
      gender: "F",
      email: "ada@example.com",
      phone: "08000000000",
      addressLine1: "12 Main St, Ikeja",
      addressLine2: "",
      city: "Lagos",
      state: "Lagos",
    };
    const sparse: Record<string, string> = {
      name: "Bolu Eze",
      admissionNumber: "ADM-002",
      class: "JSS1",
      dateOfBirth: "2012-09-14",
      gender: "M",
    };
    const line = (row: Record<string, string>) =>
      SIS_IMPORT_HEADERS.map((h) => csvCellOf(row[h] ?? "")).join(",");
    return `${SIS_IMPORT_HEADERS.join(",")}\n${line(filled)}\n${line(sparse)}\n`;
  }

  /**
   * The profile columns a row carries, mapped by the ONE table in `@sms/types`.
   *
   * Written as a loop over `SIS_IMPORT_COLUMNS` rather than as a hand-listed
   * object literal, because a hand-listed one is how `city` and `state` come to
   * be added to the template and silently dropped on the way to the database —
   * which is the same shape as the defect this whole change exists for.
   */
  private profileFieldsOf(row: StudentImportRow): Record<string, string | Date | null> {
    const source = row as unknown as Record<string, string | null | undefined>;
    const out: Record<string, string | Date | null> = {};
    for (const col of SIS_IMPORT_COLUMNS) {
      if (!col.profileField) continue;
      // `address` is the legacy single-line column and still lands on
      // addressLine1 — a file a school built last term must keep working.
      const raw = (source[col.key] ?? (col.key === "addressLine1" ? source.address : null))?.toString().trim();
      out[col.profileField] = raw ? raw : null;
    }
    // A date column is a DATE, not a string, and an unparseable one must not
    // become `Invalid Date` on the row — it is left null and the pupil is asked.
    const dob = out.dateOfBirth;
    out.dateOfBirth = typeof dob === "string" && !Number.isNaN(Date.parse(dob)) ? new Date(dob) : null;
    return out;
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

  /**
   * What this row would CHANGE on a pupil already on roll.
   *
   * A BLANK CELL NEVER CLEARS A STORED VALUE. That is the whole safety of making
   * the import an upsert: a school re-uploading its roll with only the address
   * columns filled in must not wipe every date of birth it loaded last term.
   * Blank means "I am not changing this", because the other reading destroys
   * data that nobody asked to destroy and nothing would report it.
   */
  private changesFor(
    row: StudentImportRow,
    current: Record<string, unknown>,
  ): { field: string; from: string | null; to: string | null }[] {
    const next = this.profileFieldsOf(row);
    const out: { field: string; from: string | null; to: string | null }[] = [];
    for (const [field, value] of Object.entries(next)) {
      if (value === null) continue; // blank = leave alone
      const before = current[field];
      const to = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
      const from =
        before instanceof Date
          ? before.toISOString().slice(0, 10)
          : before == null
            ? null
            : String(before);
      if (from !== to) out.push({ field, from, to });
    }
    return out;
  }

  /** Stage a PENDING batch and compute a dry-run summary (new / update / duplicate). */
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

      // WHICH ROWS MATCH A PUPIL ALREADY ON ROLL, by admission number — ONE
      // query for the whole file, never one per row. The admission number is the
      // right key: it is the school's own identifier, it is what the guardian
      // upload matches on, and unlike a generated sign-in identifier it does not
      // change when a pupil's name is corrected.
      const suppliedAdm = [
        ...new Set(rows.map((r) => r.admissionNumber?.trim()).filter((a): a is string => Boolean(a))),
      ];
      const existingProfiles = suppliedAdm.length
        ? ((await tx.studentProfile.findMany({
            where: { admissionNumber: { in: suppliedAdm } },
            select: {
              admissionNumber: true,
              dateOfBirth: true,
              gender: true,
              phone: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              state: true,
              student: { select: { name: true } },
            },
          })) as unknown as Array<Record<string, unknown> & { admissionNumber: string; student: { name: string } | null }>)
        : [];
      const byAdm = new Map(existingProfiles.map((e) => [e.admissionNumber, e]));

      let updateCount = 0;
      let unchangedCount = 0;
      const updates: StudentImportUpdatePreview[] = [];
      for (const r of rows) {
        const adm = r.admissionNumber?.trim();
        const current = adm ? byAdm.get(adm) : undefined;
        if (!current) continue;
        const changes = this.changesFor(r, current);
        if (changes.length === 0) { unchangedCount++; continue; }
        updateCount++;
        // A SAMPLE, not the file. A reviewer reads a handful of rows and a
        // total; listing five hundred would make the summary unreadable and the
        // batch row enormous — and the count is what says how many there are.
        if (updates.length < STUDENT_IMPORT_UPDATE_PREVIEW) {
          updates.push({ admissionNumber: adm as string, name: current.student?.name ?? "", changes });
        }
      }

      const summary: StudentImportSummary = {
        total: rows.length,
        // A row matching an existing pupil is no longer counted as NEW — it used
        // to be counted as a duplicate and dropped in silence.
        newCount: rows.length - duplicateCount - updateCount - unchangedCount,
        ...(unknownClasses.length ? { unknownClasses } : {}),
        ...(updateCount ? { updateCount, updates } : {}),
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

    // PHASE 1b: WHICH ROWS ARE UPDATES, asked BEFORE the hashing below.
    //
    // An update needs no account and therefore no password, and bcrypt is the
    // dominant cost of this whole operation — roughly 100 ms a row. Hashing
    // first and discovering afterwards that a row was an update would burn a
    // minute and a half of CPU on a 1,000-pupil re-upload that creates nobody,
    // and would do it again on every correction a school ever makes.
    //
    // ONE query, keyed on the admission numbers the file actually supplies. It
    // also carries the CURRENT values, because the update statement writes
    // COALESCE(new, old) and the audit needs to say what changed.
    const suppliedAdm = [
      ...new Set(rows.map((r) => r.admissionNumber?.trim()).filter((a): a is string => Boolean(a))),
    ];
    const existingByAdm = new Map<string, ExistingProfile>(
      (suppliedAdm.length
        ? ((await this.db.runAsTenantReadOnly(this.ctx(p), (tx) =>
            tx.studentProfile.findMany({
              where: { admissionNumber: { in: suppliedAdm } },
              select: {
                id: true,
                studentId: true,
                admissionNumber: true,
                dateOfBirth: true,
                gender: true,
                phone: true,
                addressLine1: true,
                addressLine2: true,
                city: true,
                state: true,
              },
            }),
          )) as unknown as ExistingProfile[])
        : []
      ).map((e) => [e.admissionNumber as string, e]),
    );
    const isUpdateRow = (r: StudentImportRow) => {
      const adm = r.admissionNumber?.trim();
      return Boolean(adm && existingByAdm.has(adm));
    };

    // PHASE 2 (outside any tx — bcrypt is slow): a UNIQUE random temporary
    // password per row THAT CREATES AN ACCOUNT. // SECURITY: the old flow gave
    // every imported student the same well-known default, so any student could
    // open any classmate's portal until they all rotated. Now each account gets
    // its own secret, returned ONCE to the approver (never stored in
    // plaintext), and passwordChangedAt=null forces the student to set their own
    // on first login.
    // SEQUENTIAL, yielding between hashes. `Promise.all` over bcryptjs starves
    // the event loop for the WHOLE batch — see foundation/bulk-hash.ts.
    const updateRows = rows.filter(isUpdateRow);
    const prepared = await hashEachWithoutBlocking(
      rows.filter((r) => !isUpdateRow(r)),
      () => crypto.randomBytes(9).toString("base64url"),
      (row, tempPassword, passwordHash) => ({ row, tempPassword, passwordHash }),
    );
    const credentials: { name: string; email: string; tempPassword: string; admissionNumber: string }[] = [];
    /** Rows that matched a pupil and would change nothing — neither created nor
     *  updated, and NOT a failure. Counted so the totals still add up. */
    let unchanged = 0;

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
        // A genuine clash now: rows matching a pupil on roll were filtered out
        // of `prepared` and are applied as UPDATES below, so anything still
        // reaching here collides with a number allocated during THIS batch.
        skipped++;
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
        // The allocated/supplied number wins over whatever the row carried, so
        // the login slip and the profile always agree.
        ...this.profileFieldsOf(row),
        admissionNumber,
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

    // The updates, and WHAT each one changes — computed here so the audit row
    // can say it and the reviewer's preview and the write cannot disagree.
    const updatePayloads: { current: ExistingProfile; next: Record<string, string | Date | null> }[] = [];
    let updatedCount = 0;
    for (const row of updateRows) {
      const current = existingByAdm.get(row.admissionNumber!.trim())!;
      const changes = this.changesFor(row, current as unknown as Record<string, unknown>);
      if (changes.length === 0) { unchanged++; continue; }
      updatePayloads.push({ current, next: this.profileFieldsOf(row) });
      updatedCount++;
    }

    // PHASE 3c (write tx): CLAIM the batch (guarded flip — a concurrent approver
    // matches 0 rows), then four bulk inserts. Milliseconds, whatever the size.
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const claimed = await tx.studentImportBatch.updateMany({
        where: { id, status: "PENDING" },
        data: { reviewedById: p.userId },
      });
      if (claimed.count === 0) throw new ConflictException("Batch already decided");
      // THE HEADROOM ABOVE WAS READ IN AN EARLIER TRANSACTION, so it is a
      // snapshot, not a reservation: two approvers deciding two batches into the
      // same class both saw the same free places and both filled them. Re-assert
      // here, inside the write, where the class row can actually be LOCKED —
      // then a second approver waits and is refused rather than overfilling.
      //
      // The whole batch is refused rather than trimmed: the sign-in slips ride
      // on this response and are shown once, so silently dropping pupils would
      // hand the approver credentials for children who were never enrolled.
      const wanted = new Map<string, number>();
      for (const e of newEnrolments) wanted.set(e.classId, (wanted.get(e.classId) ?? 0) + 1);
      for (const [classId, n] of wanted) {
        try {
          await assertClassCapacity(tx, classId, n);
        } catch (err) {
          // SAY WHAT HAPPENED TO THE BATCH. The guard names the class, which is
          // the fact the approver needs; on its own it leaves them wondering
          // whether some of the roll went in. Nothing did — the claim above
          // rolls back with this throw — and the sibling P2002 refusal three
          // lines down has always said so.
          if (err instanceof ConflictException) {
            throw new ConflictException(
              `${err.message} Nothing was imported and the batch is still waiting for review — ` +
                `free up places or move those pupils to another class, then approve it again.`,
            );
          }
          throw err;
        }
      }
      try {
        for (const chunk of chunked(newUsers, 500)) await tx.user.createMany({ data: chunk });
        for (const chunk of chunked(newRoles, 500)) await tx.userRole.createMany({ data: chunk });
        for (const chunk of chunked(newProfiles, 500)) await tx.studentProfile.createMany({ data: chunk });
        for (const chunk of chunked(newEnrolments, 500)) await tx.enrollment.createMany({ data: chunk });
        // THE UPDATES, IN ONE STATEMENT PER CHUNK — never one per pupil.
        //
        // Prisma has no bulk update with per-row values, and a loop of
        // `update()` calls inside an interactive transaction is precisely the
        // trap this method already carries a comment about: Prisma caps one at
        // FIVE SECONDS, so a school correcting 400 records would get "Internal
        // server error" and whether it worked would depend on how busy the task
        // was. An UPDATE ... FROM (VALUES …) is one round trip whatever the size.
        //
        // COALESCE(new, old) is the semantic, and it is the reason an upsert is
        // safe to offer at all: a BLANK CELL LEAVES THE STORED VALUE ALONE. A
        // school re-uploading its roll with only the address columns filled must
        // not wipe every date of birth it loaded last term — and nothing would
        // have reported that, because a cleared field looks exactly like one
        // that was never supplied.
        for (const chunk of chunked(updatePayloads, 500)) {
          const values = Prisma.join(
            chunk.map(
              (u) => Prisma.sql`(${u.current.id}::uuid, ${
                u.next.dateOfBirth as Date | null
              }::date, ${u.next.gender as string | null}::text, ${u.next.phone as string | null}::text, ${
                u.next.addressLine1 as string | null
              }::text, ${u.next.addressLine2 as string | null}::text, ${
                u.next.city as string | null
              }::text, ${u.next.state as string | null}::text)`,
            ),
          );
          await tx.$executeRaw`
            UPDATE student_profile p SET
              "dateOfBirth"  = COALESCE(v."dateOfBirth", p."dateOfBirth"),
              gender         = COALESCE(v.gender, p.gender),
              phone          = COALESCE(v.phone, p.phone),
              "addressLine1" = COALESCE(v."addressLine1", p."addressLine1"),
              "addressLine2" = COALESCE(v."addressLine2", p."addressLine2"),
              city           = COALESCE(v.city, p.city),
              state          = COALESCE(v.state, p.state),
              "updatedAt"    = now()
            FROM (VALUES ${values}) AS v(id, "dateOfBirth", gender, phone, "addressLine1", "addressLine2", city, state)
            WHERE p.id = v.id
          `;
        }
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
        // The whole file, not just the rows that could create — `prepared` no
        // longer holds the update rows, so reading its length here would report
        // a 400-row correction as a 0-row import.
        total: prepared.length + updateRows.length,
        newCount: created,
        duplicateCount: skipped,
        created,
        updated: updatedCount,
        skipped,
        errors: errors.length,
      };
      const updated = await tx.studentImportBatch.update({
        where: { id },
        data: { status: "APPROVED", reviewedById: p.userId, summary: summary as unknown as Prisma.InputJsonValue },
      });
      await this.log(tx, p, "student.import.approve", id, {
        created,
        updated: updatedCount,
        unchanged,
        skipped,
        errors: errors.length,
        // WHOSE record changed, so the trail names the pupils rather than only
        // counting them. Admission numbers, not names: the trail is read beside
        // the school's own register.
        updatedAdmissionNumbers: updatePayloads.map((u) => u.current.admissionNumber),
      });
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
