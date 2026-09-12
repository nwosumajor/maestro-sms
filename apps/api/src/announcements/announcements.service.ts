// =============================================================================
// AnnouncementsService — school-wide notices
// =============================================================================
// A principal / school_admin posts a notice to their school; students, parents,
// and staff read it on the announcements page. ONE row is read by many (no
// per-recipient fan-out). Reads are audience-filtered by the caller's role:
//   - student-side (student / parent): ALL + STUDENTS
//   - staff: everything (ALL + STUDENTS + STAFF)
// Tenant-scoped (RLS); mutations audited.
// =============================================================================

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isStaffRoles } from "@sms/types";
import type { AnnouncementDto, AnnouncementPageDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";


interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  audience: string;
  createdById: string;
  createdAt: Date;
}

/** One page of the notice board. A cap is only honest with a total beside it. */
const BOARD_PAGE_SIZE = 100;

@Injectable()
export class AnnouncementsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Post a school announcement (principal / school_admin). */
  async create(p: Principal, input: { title: string; body: string; audience: "ALL" | "STUDENTS" | "STAFF" }) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.announcement.create({
        data: {
          schoolId: p.schoolId,
          title: input.title,
          body: input.body,
          audience: input.audience,
          createdById: p.userId,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "announcement.create", entity: "announcement", entityId: a.id, schoolId: p.schoolId, metadata: { audience: input.audience } },
        tx,
      );
      const author = await tx.user.findFirst({ where: { id: p.userId }, select: { name: true } });
      return this.toDto(a as AnnouncementRow, author?.name ?? "");
    });
  }

  async remove(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.announcement.findFirst({ where: { id }, select: { id: true } });
      if (!a) throw new NotFoundException("Announcement not found");
      await tx.announcement.delete({ where: { id } });
      await this.audit.record(
        { actorId: p.userId, action: "announcement.delete", entity: "announcement", entityId: id, schoolId: p.schoolId },
        tx,
      );
      return { id, deleted: true };
    });
  }

  /**
   * The school's notice board, audience-filtered, newest first.
   *
   * PAGED, COUNTED AND SEARCHABLE. This was the newest 100 with none of the
   * three. Measured on a five-year school posting ~2.5 notices a week (501
   * held): a principal reached back only to 2025-01-26 and a parent to
   * 2024-11-09, so three to four years of what the school had told families
   * were unreachable at any URL, with nothing on the page saying so.
   *
   * A board is read to answer "what did the school say about X", so `q`
   * searches title and body IN SQL — narrowing the fetched page in the browser
   * could only ever see the rows that survived the cap. The audience filter is
   * unchanged and still applies to the search and the count alike: widening the
   * REACH must not widen who may read what.
   */
  async list(
    p: Principal,
    opts: { q?: string; page?: number } = {},
  ): Promise<AnnouncementPageDto> {
    const audiences = this.audiencesFor(p);
    const page = Math.max(1, opts.page ?? 1);
    const q = opts.q?.trim() || undefined;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where = {
        audience: { in: audiences as ("ALL" | "STUDENTS" | "STAFF")[] },
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: "insensitive" as const } },
                { body: { contains: q, mode: "insensitive" as const } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.announcement.findMany({
          where,
          // `id` breaks ties: a batch posted at the start of term shares a
          // createdAt, and offset paging over a partial order silently skips
          // and repeats rows.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: BOARD_PAGE_SIZE,
          skip: (page - 1) * BOARD_PAGE_SIZE,
        }),
        // Counted over the SAME predicate the page is drawn from, audience
        // included — a total the caller may not actually read would be worse
        // than no total.
        tx.announcement.count({ where }),
      ]);
      // Resolve author names (small set; one query).
      const ids = [...new Set(rows.map((r) => r.createdById))];
      const authors = ids.length
        ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        : [];
      const nameOf = new Map(authors.map((u: { id: string; name: string }) => [u.id, u.name]));
      const items = (rows as AnnouncementRow[]).map((r) => this.toDto(r, nameOf.get(r.createdById) ?? ""));
      return { items, total, shown: items.length, page, pageSize: BOARD_PAGE_SIZE };
    });
  }

  /** Which audiences the caller may read. A caller is "student-side" iff they hold
   *  ONLY student/parent roles (every() over an empty role set is true → student-
   *  side, the least-privilege default); anyone with ANY staff role also sees
   *  STAFF notices. Positive check — no double negation. */
  private audiencesFor(p: Principal): ("ALL" | "STUDENTS" | "STAFF")[] {
    const studentSideOnly = !isStaffRoles(p.roles);
    return studentSideOnly ? ["ALL", "STUDENTS"] : ["ALL", "STUDENTS", "STAFF"];
  }

  private toDto(r: AnnouncementRow, authorName: string): AnnouncementDto {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      audience: r.audience,
      authorName,
      createdAt: r.createdAt,
    };
  }
}
