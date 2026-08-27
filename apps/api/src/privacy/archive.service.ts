// =============================================================================
// SchoolArchiveService — the artifact that answers a question asked in ten years
// =============================================================================
// A school needs to produce, once a year, something it can still read in a
// decade when an investigator or a regulator asks about 2026.
//
// WHY NOT A BACKUP. A backup is disaster recovery. Answering one question about
// one pupil by restoring a ten-year-old database means provisioning spare
// infrastructure and a multi-hour operation, and the off-site archives only
// reach 365 days anyway. This produces a retrieval artifact instead: one object,
// downloadable through the vault's ordinary audited path.
//
// WHY IT MATTERS MORE NOW. The retention sweeps deliberately DELETE telemetry on
// a schedule. Whatever is not archived is genuinely, permanently gone.
//
// TWO THINGS THAT SHAPE THE DESIGN
//
//   1. IT CONTAINS DECRYPTED SALARIES. Field encryption uses a key that may be
//      rotated or lost in ten years, so an archive full of ciphertext would be
//      worthless — exactly when you need it, you could not read it. The figures
//      are decrypted at archive time and the ARTIFACT is gated instead: its own
//      permission, step-up on both creation and retrieval, every access audited.
//   2. IT MUST BE BOUNDED. A year of attendance and audit rows for a large
//      school does not fit comfortably in memory. Every unbounded section is
//      read in pages and the caps are RECORDED in the manifest, so a truncated
//      archive says so rather than looking complete.
// =============================================================================

import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type TenantDatabase,
  type TenantContext,
  type TenantTx,
  type Principal,
} from "../integrity/integrity.foundation";
import { STORAGE_PROVIDER, type StorageProvider } from "../documents/storage.provider";
import { decryptField } from "../foundation/field-crypto";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";

/** Days after a term ends before it is archived, so late marks and corrections
 *  entered in the final week are inside the snapshot rather than outside it. */
const TERM_ARCHIVE_GRACE_DAYS = Number(process.env.TERM_ARCHIVE_GRACE_DAYS ?? 7);
export const TERM_ARCHIVE_QUEUE = "term-archive";
export const TERM_ARCHIVE_JOB = "term-archive";
export const TERM_ARCHIVE_SCHEDULER_ID = "term-archive-scheduler";
/** Daily. It does nothing on almost every day; the cost of checking is a query. */
export const DEFAULT_TERM_ARCHIVE_CRON = "40 2 * * *";

/** Rows read per page from the large sections. */
const PAGE = 1_000;
/** Hard ceiling per section. A truncated archive is recorded as truncated. */
const SECTION_CAP = 200_000;

/** A whole-school export is not a page load. Long enough for fifteen years of a
 *  large school, short enough that a runaway read still ends — and it is a
 *  scheduled, once-a-term operation, so the open snapshot costs little. */
const ARCHIVE_TIMEOUT_MS = 120_000;

export interface ArchiveSummary {
  id: string;
  label: string;
  sizeBytes: number;
  checksum: string;
  sections: Record<string, number>;
  containsHrPii: boolean;
  createdAt: Date;
}

/**
 * Categories deliberately NOT carried by a school archive.
 *
 * Declared as DATA so the manifest and this list cannot drift, and so adding a
 * section is visibly a decision: something either moves into the archive or
 * gains an entry here.
 *
 * // THE MEDICAL ONE IS THE LOAD-BEARING DECISION. `medical_record` is
 * field-encrypted per tenant (Golden Rule #5) and its columns are NOT
 * `Enc`-suffixed, so the staff decryption pass — which keys on that suffix —
 * would not have reached them even if the section existed: the archive would
 * have carried a child's allergies as unreadable ciphertext while looking
 * complete. Widening what leaves the building for minors' medical data is a
 * policy decision with Golden Rule #5 weight and is NOT taken here; what is
 * taken here is saying so.
 */
const EXCLUDED_SECTIONS: ReadonlyArray<{ section: string; reason: string }> = [
  {
    section: "medicalRecords",
    reason:
      "Minors' medical data is field-encrypted per tenant and every read is audited. " +
      "Ask the school's data controller for a medical extract; a pupil's own record is " +
      "also in their NDPR export bundle.",
  },
  {
    section: "emergencyContacts",
    reason: "Contact details for named third parties. Ask the data controller.",
  },
  {
    section: "guardians",
    reason:
      "The parent-child links are personal data about the ADULT, not the pupil. " +
      "A pupil's own guardian links are in their NDPR export bundle.",
  },
  {
    section: "documents",
    reason:
      "Report cards, receipts and certificates live in object storage; this file " +
      "carries no bytes. Download them from the Document Vault.",
  },
  {
    section: "disciplineAndRemarks",
    reason:
      "Discipline records, class-teacher remarks and character ratings are OPINION " +
      "data about a child. Ask the data controller; a pupil's own are in their " +
      "NDPR export bundle.",
  },
];

@Injectable()
export class SchoolArchiveService {
  private readonly logger = new Logger("SchoolArchive");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /**
   * Read a whole table for this school in pages.
   *
   * Returns the rows AND whether it stopped early, because a section that hit
   * the cap must be reported as capped — an archive that silently contains half
   * a year's attendance is worse than one that admits it does.
   */
  private async page<T>(
    read: (skip: number, take: number) => Promise<T[]>,
  ): Promise<{ rows: T[]; truncated: boolean }> {
    const rows: T[] = [];
    for (let skip = 0; skip < SECTION_CAP; skip += PAGE) {
      const batch = await read(skip, PAGE);
      rows.push(...batch);
      if (batch.length < PAGE) return { rows, truncated: false };
      if (rows.length >= SECTION_CAP) break;
    }
    return { rows, truncated: true };
  }


  /**
   * Read a partitioned month at a time, so nothing is sorted or skipped.
   *
   * OFFSET paging over a large table costs O(pages x rows) when the ordering
   * column is unindexed, and every page pays it again. Walking the partition
   * key instead prunes each read to a single partition. The cap is still
   * honoured and still REPORTED — an archive that quietly holds half a year's
   * attendance is worse than one that admits it.
   */
  private async byMonth(
    tx: TenantTx,
    section: string,
    sections: Record<string, number>,
    truncated: string[],
    window: { from: Date; to: Date } | null,
  ): Promise<Array<Record<string, unknown>>> {
    // A scoped archive walks only its own months — which, on a table
    // partitioned by `date`, means it touches only its own partitions.
    const bounds = window
      ? { _min: { date: window.from }, _max: { date: window.to } }
      : ((await tx.attendanceRecord.aggregate({
          _min: { date: true },
          _max: { date: true },
        })) as { _min: { date: Date | null }; _max: { date: Date | null } });
    const first = bounds._min.date;
    const last = bounds._max.date;
    const rows: Array<Record<string, unknown>> = [];
    if (!first || !last) {
      sections[section] = 0;
      return rows;
    }
    let cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
    const end = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1));
    while (cursor < end) {
      const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      const batch = (await tx.attendanceRecord.findMany({
        where: {
          date: {
            gte: window && window.from > cursor ? window.from : cursor,
            ...(window && window.to < next ? { lte: window.to } : { lt: next }),
          },
        },
        orderBy: { date: "asc" },
        take: SECTION_CAP - rows.length,
      })) as Array<Record<string, unknown>>;
      // NOT `push(...batch)`. A month can be tens of thousands of rows and the
      // spread passes every one as an argument — `RangeError: Maximum call
      // stack size exceeded`. The old helper only escaped it because its pages
      // were a thousand rows; this reads a whole month at once.
      for (const row of batch) rows.push(row);
      if (rows.length >= SECTION_CAP) {
        truncated.push(section);
        break;
      }
      cursor = next;
    }
    sections[section] = rows.length;
    return rows;
  }

  /**
   * Build and store the archive.
   *
   * Assembled under the ordinary tenant path, so RLS bounds every read to this
   * school — the archive cannot accidentally contain another school's rows even
   * if a query forgot its filter.
   */
  async create(p: Principal, input: { label: string; sessionId?: string; termId?: string }): Promise<ArchiveSummary> {
    const label = input.label.trim();
    if (!label) throw new BadRequestException("An archive needs a label, e.g. 2025/2026.");

    // A WHOLE SCHOOL, not a screen. The default 5-second interactive cap is
    // right for a page load and wrong for this: measured live at 173,701
    // attendance rows it failed at 5,033 ms with "Transaction already closed",
    // so no school big enough to want an archive could produce one.
    const { bundle, sections } = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) =>
      this.assemble(tx, p.schoolId, { sessionId: input.sessionId, termId: input.termId }),
      { timeoutMs: ARCHIVE_TIMEOUT_MS },
    );

    // // GOTCHA: `JSON.stringify` THROWS on a BigInt, and this bundle carries
    // several — `payroll_run.totalGrossMinor` and `totalNetMinor` are int8,
    // deliberately, because "int4 can overflow a lifetime kobo total" (the same
    // note the analytics aggregates carry). So any school that had ever run
    // payroll could not produce an archive at all: measured live, the whole
    // export completed and then died on "Do not know how to serialize a
    // BigInt".
    //
    // Rendered as a decimal STRING, not a number: a JS number cannot hold what
    // an int8 can, and silently rounding a payroll total inside the artifact a
    // school keeps for fifteen years is worse than failing loudly. A reader in
    // ten years gets exact digits.
    const body = Buffer.from(
      JSON.stringify(bundle, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 1),
      "utf8",
    );
    const checksum = createHash("sha256").update(body).digest("hex");
    const storageKey = `schools/${p.schoolId}/archives/${Date.now()}-${label.replace(/[^\w.-]+/g, "-")}.json`;
    await this.storage.upload({ key: storageKey, body, contentType: "application/json" });

    const row = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const created = (await tx.schoolArchive.create({
        data: {
          schoolId: p.schoolId,
          sessionId: input.sessionId ?? null,
          termId: input.termId ?? null,
          label,
          storageKey,
          checksum,
          sizeBytes: body.length,
          sections,
          containsHrPii: true,
          createdById: p.userId,
        },
      })) as { id: string; createdAt: Date };
      await this.audit.record(
        {
          actorId: p.userId,
          action: "privacy.archive.create",
          entity: "school_archive",
          entityId: created.id,
          schoolId: p.schoolId,
          // Counts and checksum, never the contents.
          metadata: { label, checksum, sizeBytes: body.length, sections },
        },
        tx,
      );
      return created;
    });

    this.logger.log(`archive ${label} for school=${p.schoolId} ${body.length} bytes sha256=${checksum.slice(0, 12)}`);
    return {
      id: row.id,
      label,
      sizeBytes: body.length,
      checksum,
      sections: sections as Record<string, number>,
      containsHrPii: true,
      createdAt: row.createdAt,
    };
  }

  /** Everything the institution did, as at now. */
  /**
   * The window an archive covers, resolved from the term or session it names.
   *
   * // GOTCHA: `sessionId` was accepted, stored on the row, written into the
   * manifest — and FILTERED NOTHING. Every archive was a whole-school dump
   * whatever it was labelled. The tell was sitting in the data: three stored
   * archives named "Term 1", "Second Term" and "Third Term" measured 1422,
   * 1422 and 1423 KB — near-identical, because they were the same export three
   * times.
   *
   * Two costs, and the second is worse. The daily sweep archives EVERY ENDED
   * TERM, so fifteen years is 45 copies of the school's entire history, each
   * larger than the last — at today's 90 MB and growing, hundreds of gigabytes
   * of near-duplicate. And a reader opening "Third Term 2026" in ten years got
   * a document that misrepresented itself: the whole school, including years
   * either side of the one on the label.
   */
  private async windowFor(
    tx: TenantTx,
    scope: { sessionId?: string; termId?: string },
  ): Promise<{ from: Date; to: Date; label: string } | null> {
    if (scope.termId) {
      const t = (await tx.term.findFirst({
        where: { id: scope.termId },
        select: { name: true, startDate: true, endDate: true },
      })) as { name: string; startDate: Date | null; endDate: Date | null } | null;
      if (!t) throw new NotFoundException("Term not found");
      if (!t.startDate || !t.endDate) {
        // Refused, not silently widened. An archive that claims to be a term
        // and holds everything is the defect this replaces.
        throw new BadRequestException(
          `Term "${t.name}" has no start or end date, so an archive cannot be scoped to it. Set the dates, or archive without naming a term.`,
        );
      }
      return { from: t.startDate, to: t.endDate, label: t.name };
    }
    if (scope.sessionId) {
      const sess = (await tx.academicSession.findFirst({
        where: { id: scope.sessionId },
        select: { name: true, startDate: true, endDate: true },
      })) as { name: string; startDate: Date | null; endDate: Date | null } | null;
      if (!sess) throw new NotFoundException("Session not found");
      if (!sess.startDate || !sess.endDate) {
        throw new BadRequestException(
          `Session "${sess.name}" has no start or end date, so an archive cannot be scoped to it. Set the dates, or archive without naming a session.`,
        );
      }
      return { from: sess.startDate, to: sess.endDate, label: sess.name };
    }
    // Neither named: a deliberate WHOLE-SCHOOL export, which is what a school
    // leaving or backing up everything actually wants.
    return null;
  }

  private async assemble(tx: TenantTx, schoolId: string, scope: { sessionId?: string; termId?: string }) {
    const sections: Record<string, number> = {};
    const truncated: string[] = [];
    const window = await this.windowFor(tx, scope);
    /** Sections bounded by the window; the rest are point-in-time snapshots. */
    const inWindow = window ? { gte: window.from, lte: window.to } : undefined;
    const take = async <T>(name: string, read: (skip: number, take: number) => Promise<T[]>) => {
      const { rows, truncated: cut } = await this.page(read);
      sections[name] = rows.length;
      if (cut) truncated.push(name);
      return rows;
    };

    const students = await take("students", (skip, n) =>
      tx.user.findMany({
        where: { roles: { some: { role: { name: "student" } } } },
        select: { id: true, name: true, email: true, uniqueId: true, status: true, createdAt: true },
        skip, take: n, orderBy: { createdAt: "asc" },
      }),
    );
    const profiles = await take("studentProfiles", (skip, n) =>
      tx.studentProfile.findMany({ skip, take: n, orderBy: { createdAt: "asc" } }),
    );
    const enrollments = await take("enrollments", (skip, n) =>
      tx.enrollment.findMany({
        where: inWindow ? { enrolledAt: inWindow } : {},
        skip, take: n, orderBy: { enrolledAt: "asc" },
      }),
    );
    // ATTENDANCE IS WALKED BY MONTH, not by OFFSET.
    //
    // `skip`/`take` with `ORDER BY createdAt` re-sorted the WHOLE table on
    // every page — `createdAt` has never carried an index — so a school with a
    // real register paid a 173,701-row external merge sort 174 times over and
    // the archive blew the 5-second interactive-transaction cap: measured
    // live, `POST /privacy/archives` answered 500 after 5,033 ms with
    // "Transaction already closed". The artifact that exists SO A SCHOOL CAN
    // KEEP ITS RECORD could not be produced by any school large enough to need
    // it, and the section counts on the three archives already stored read
    // `attendance: 0`.
    //
    // The table is now RANGE-partitioned by month on `date`, so asking for one
    // month prunes to one partition and reads it whole — no sort, no offset,
    // and the cost is O(rows) instead of O(pages x rows).
    const attendance = await this.byMonth(tx, "attendance", sections, truncated, window);
    // Scoped on its OWN columns, not on a date window: a result carries the
    // term and session it belongs to, so this is exact rather than inferred
    // from when somebody happened to enter the mark.
    const results = await take("subjectResults", (skip, n) =>
      tx.subjectResult.findMany({
        where: scope.termId ? { termId: scope.termId } : scope.sessionId ? { sessionId: scope.sessionId } : {},
        skip, take: n, orderBy: { gradedAt: "asc" },
      }),
    );
    const invoices = await take("invoices", (skip, n) =>
      tx.invoice.findMany({
        where: inWindow ? { createdAt: inWindow } : {},
        include: { lineItems: true, payments: true },
        skip, take: n, orderBy: { createdAt: "asc" },
      }),
    );
    const workflows = await take("workflowRequests", (skip, n) =>
      tx.workflowRequest.findMany({
        where: inWindow ? { createdAt: inWindow } : {},
        skip, take: n, orderBy: { createdAt: "asc" },
      }),
    );
    // Prunes to the months in the window — audit_log is partitioned on
    // createdAt, so a term's archive reads a term's partitions.
    const auditLog = await take("auditLog", (skip, n) =>
      tx.auditLog.findMany({
        where: inWindow ? { createdAt: inWindow } : {},
        skip, take: n, orderBy: { createdAt: "asc" },
      }),
    );

    // STAFF — employment records with the encrypted fields RESOLVED. See the file
    // header: ciphertext in a ten-year archive is unreadable exactly when needed.
    const rawStaff = await take("staff", (skip, n) =>
      tx.employee.findMany({ skip, take: n, orderBy: { createdAt: "asc" } }),
    );
    const staff = (rawStaff as Array<Record<string, unknown>>).map((e) => {
      const out: Record<string, unknown> = { ...e };
      for (const [k, v] of Object.entries(e)) {
        if (!k.endsWith("Enc")) continue;
        // Renamed whether or not there was a value. A null that kept its `Enc`
        // suffix would leave the archive with two different shapes for the same
        // field, and the person reading this in ten years has no way to know the
        // suffix meant "empty" rather than "still encrypted, good luck".
        out[k.slice(0, -3)] = typeof v === "string" && v ? decryptField(v, schoolId) ?? null : null;
        delete out[k];
      }
      return out;
    });
    const payroll = await take("payrollRuns", (skip, n) =>
      tx.payrollRun.findMany({ skip, take: n, orderBy: { createdAt: "asc" } }),
    );

    return {
      sections,
      bundle: {
        manifest: {
          schoolId,
          sessionId: scope.sessionId ?? null,
          termId: scope.termId ?? null,
          producedAt: new Date().toISOString(),
          formatVersion: 2,
          /**
           * WHAT THIS ARCHIVE ACTUALLY COVERS.
           *
           * Absent means the WHOLE school — a deliberate full export, which is
           * what a school leaving or backing everything up wants. Present means
           * the sections below were bounded to it.
           */
          coversFrom: window ? window.from.toISOString().slice(0, 10) : null,
          coversTo: window ? window.to.toISOString().slice(0, 10) : null,
          coversLabel: window ? window.label : "whole school",
          /** Bounded to the window above. */
          scopedSections: window
            ? ["enrollments", "attendance", "subjectResults", "invoices", "workflowRequests", "auditLog"]
            : [],
          /**
           * NOT bounded — a point-in-time picture as at `producedAt`, and said
           * so rather than left to be assumed. A roster and an employment
           * record have no term: scoping them to one would produce an archive
           * missing the very people its other sections are about.
           */
          snapshotSections: ["students", "studentProfiles", "staff", "payrollRuns"],
          // Named loudly: whoever opens this in ten years must know what is in it
          // before they forward it to anyone.
          contains: "Whole institutional record, INCLUDING staff employment records and decrypted salaries.",
          /**
           * WHAT IS NOT IN HERE, and why.
           *
           * The same ambiguity the student export bundle's `coverage` manifest
           * exists to remove, one level up: a school opening this in ten years
           * cannot otherwise tell whether a missing emergency contact means the
           * child had none or means the archive never carried them. This
           * artifact is what a school takes away for its own retention, so the
           * question "is this all of it?" has to be answerable FROM the file.
           *
           * Each entry says what to ask for instead — a reader ten years from
           * now has no other route.
           */
          excludedSections: EXCLUDED_SECTIONS,
          // A capped section is stated. An archive that silently holds half a
          // year would be believed to be complete.
          truncatedSections: truncated,
          sectionCounts: sections,
        },
        students, studentProfiles: profiles, enrollments, attendance,
        subjectResults: results, invoices, workflowRequests: workflows,
        auditLog, staff, payrollRuns: payroll,
      },
    };
  }

  /** The archives this school holds. Metadata only — never the contents. */
  async list(p: Principal): Promise<ArchiveSummary[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = (await tx.schoolArchive.findMany({ orderBy: { createdAt: "desc" } })) as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => ({
        id: String(r.id),
        label: String(r.label),
        sizeBytes: Number(r.sizeBytes),
        checksum: String(r.checksum),
        sections: (r.sections ?? {}) as Record<string, number>,
        containsHrPii: Boolean(r.containsHrPii),
        createdAt: r.createdAt as Date,
      }));
    });
  }

  /**
   * A time-limited link to the archive body.
   *
   * AUDITED BEFORE THE URL IS MINTED, not after: once the link exists the
   * download can happen anywhere, so the record of who asked has to be written
   * whether or not they go on to fetch it.
   */
  async download(p: Principal, archiveId: string): Promise<{ url: string; checksum: string }> {
    const row = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) =>
      tx.schoolArchive.findFirst({ where: { id: archiveId } }),
    );
    if (!row) throw new NotFoundException("Not found");
    const rec = row as unknown as { storageKey: string; checksum: string; label: string };

    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "privacy.archive.download",
          entity: "school_archive",
          entityId: archiveId,
          schoolId: p.schoolId,
          metadata: { label: rec.label, checksum: rec.checksum },
        },
        tx,
      ),
    );
    const { url } = await this.storage.presignDownload({
      key: rec.storageKey,
      filename: `${rec.label.replace(/[^\w.-]+/g, "-")}-archive.json`,
    });
    // Returned so the recipient can verify the bytes are the bytes we recorded.
    return { url, checksum: rec.checksum };
  }

  /**
   * ARCHIVE EVERY TERM THAT HAS ENDED AND IS NOT YET ARCHIVED.
   *
   * Runs daily and does nothing on almost every day — which is the point. A term
   * boundary is a date nobody is watching for, and "take the archive at the end
   * of term" is exactly the instruction a school forgets in the week it matters
   * most, because the end of term is the busiest week they have.
   *
   * WHY A TERM AND NOT A YEAR. A year-end archive means a question about the
   * first term is answered from a snapshot taken eight months later, by which
   * time the retention sweeps have already deleted that term's telemetry. Per
   * term, the data is archived while it still exists.
   *
   * IDEMPOTENT IN THE DATABASE, not in this method: a UNIQUE (schoolId, termId)
   * means a second attempt fails at the constraint rather than relying on this
   * sweep's memory, which a restart erases. A duplicate archive is not harmless
   * — two files with one name and different checksums is the ambiguity the whole
   * feature exists to prevent.
   *
   * Runs as SYSTEM, per school, through the ordinary tenant path so RLS still
   * bounds every read.
   */
  async archiveEndedTerms(
    trigger: "SCHEDULED" | "MANUAL",
  ): Promise<{ scanned: number; archived: number; skipped: number; undated: number }> {
    const client = this.privileged.client;
    const result = { scanned: 0, archived: 0, skipped: 0, undated: 0 };
    if (!client) {
      if (trigger === "SCHEDULED") this.logger.log("term archive skipped (no privileged client)");
      return result;
    }

    // A grace window: archive a few days AFTER the term ends, so late marks and
    // corrections entered in the final week are inside the snapshot rather than
    // stranded outside it.
    const cutoff = new Date(Date.now() - TERM_ARCHIVE_GRACE_DAYS * 86_400_000);
    const terms = (await client.term.findMany({
      where: { endDate: { not: null, lt: cutoff } },
      select: { id: true, schoolId: true, name: true, sessionId: true, endDate: true, startDate: true },
      orderBy: { endDate: "asc" },
      take: 500,
    })) as Array<{ id: string; schoolId: string; name: string; sessionId: string; endDate: Date; startDate: Date | null }>;

    // A term with no START date cannot be archived AS a term — the window is
    // what makes the archive about that term rather than about everything.
    // Counted and reported rather than retried and logged every night: a sweep
    // that fails on the same rows for ever teaches its reader to ignore it.
    const undated = terms.filter((t) => !t.startDate);
    result.undated = undated.length;
    if (undated.length > 0) {
      this.logger.warn(
        `${undated.length} ended term(s) have no start date and were not archived: ` +
          undated.map((t) => `${t.name} (school=${t.schoolId})`).join(", "),
      );
    }

    const already = new Set(
      (
        (await client.schoolArchive.findMany({
          where: { termId: { in: terms.map((t) => t.id) } },
          select: { termId: true },
        })) as Array<{ termId: string | null }>
      ).map((a) => a.termId),
    );

    for (const t of terms.filter((t) => t.startDate)) {
      result.scanned++;
      if (already.has(t.id)) {
        result.skipped++;
        continue;
      }
      try {
        // SYSTEM actor: nobody clicked this, and attributing it to a person
        // would put a name against an act they did not perform.
        await this.create(
          { schoolId: t.schoolId, userId: SYSTEM_ACTOR_ID, roles: [], permissions: [] },
          { label: t.name, sessionId: t.sessionId, termId: t.id },
        );
        result.archived++;
        this.logger.log(`archived term ${t.name} for school=${t.schoolId}`);
      } catch (err) {
        // One school's failure must not stop the rest. A term left unarchived is
        // retried tomorrow; a sweep that dies halfway is not.
        result.skipped++;
        this.logger.error(`term archive failed school=${t.schoolId} term=${t.id}: ${(err as Error).message}`);
      }
    }
    return result;
  }
}