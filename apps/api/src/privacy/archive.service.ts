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

/** Rows read per page from the large sections. */
const PAGE = 1_000;
/** Hard ceiling per section. A truncated archive is recorded as truncated. */
const SECTION_CAP = 200_000;

export interface ArchiveSummary {
  id: string;
  label: string;
  sizeBytes: number;
  checksum: string;
  sections: Record<string, number>;
  containsHrPii: boolean;
  createdAt: Date;
}

@Injectable()
export class SchoolArchiveService {
  private readonly logger = new Logger("SchoolArchive");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
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
   * Build and store the archive.
   *
   * Assembled under the ordinary tenant path, so RLS bounds every read to this
   * school — the archive cannot accidentally contain another school's rows even
   * if a query forgot its filter.
   */
  async create(p: Principal, input: { label: string; sessionId?: string }): Promise<ArchiveSummary> {
    const label = input.label.trim();
    if (!label) throw new BadRequestException("An archive needs a label, e.g. 2025/2026.");

    const { bundle, sections } = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) =>
      this.assemble(tx, p.schoolId, input.sessionId),
    );

    const body = Buffer.from(JSON.stringify(bundle, null, 1), "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const storageKey = `schools/${p.schoolId}/archives/${Date.now()}-${label.replace(/[^\w.-]+/g, "-")}.json`;
    await this.storage.upload({ key: storageKey, body, contentType: "application/json" });

    const row = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const created = (await tx.schoolArchive.create({
        data: {
          schoolId: p.schoolId,
          sessionId: input.sessionId ?? null,
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
  private async assemble(tx: TenantTx, schoolId: string, sessionId?: string) {
    const sections: Record<string, number> = {};
    const truncated: string[] = [];
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
      tx.enrollment.findMany({ skip, take: n, orderBy: { enrolledAt: "asc" } }),
    );
    const attendance = await take("attendance", (skip, n) =>
      tx.attendanceRecord.findMany({ skip, take: n, orderBy: { createdAt: "asc" } }),
    );
    const results = await take("subjectResults", (skip, n) =>
      tx.subjectResult.findMany({ skip, take: n, orderBy: { gradedAt: "asc" } }),
    );
    const invoices = await take("invoices", (skip, n) =>
      tx.invoice.findMany({ include: { lineItems: true, payments: true }, skip, take: n, orderBy: { createdAt: "asc" } }),
    );
    const workflows = await take("workflowRequests", (skip, n) =>
      tx.workflowRequest.findMany({ skip, take: n, orderBy: { createdAt: "asc" } }),
    );
    const auditLog = await take("auditLog", (skip, n) =>
      tx.auditLog.findMany({ skip, take: n, orderBy: { createdAt: "asc" } }),
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
          sessionId: sessionId ?? null,
          producedAt: new Date().toISOString(),
          formatVersion: 1,
          // Named loudly: whoever opens this in ten years must know what is in it
          // before they forward it to anyone.
          contains: "Whole institutional record, INCLUDING staff employment records and decrypted salaries.",
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
}
