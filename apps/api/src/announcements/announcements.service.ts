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
import type { AnnouncementDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const STUDENT_SIDE_ROLES = new Set(["student", "parent"]);

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  audience: string;
  createdById: string;
  createdAt: Date;
}

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

  /** List the school's announcements visible to the caller (audience-filtered). */
  async list(p: Principal): Promise<AnnouncementDto[]> {
    const audiences = this.audiencesFor(p);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = (await tx.announcement.findMany({
        where: { audience: { in: audiences as ("ALL" | "STUDENTS" | "STAFF")[] } },
        orderBy: { createdAt: "desc" },
        take: 100,
      })) as AnnouncementRow[];
      // Resolve author names (small set; one query).
      const ids = [...new Set(rows.map((r) => r.createdById))];
      const authors = ids.length
        ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        : [];
      const nameOf = new Map(authors.map((u: { id: string; name: string }) => [u.id, u.name]));
      return rows.map((r) => this.toDto(r, nameOf.get(r.createdById) ?? ""));
    });
  }

  /** Which audiences the caller may read. A caller is "student-side" iff they hold
   *  ONLY student/parent roles (every() over an empty role set is true → student-
   *  side, the least-privilege default); anyone with ANY staff role also sees
   *  STAFF notices. Positive check — no double negation. */
  private audiencesFor(p: Principal): ("ALL" | "STUDENTS" | "STAFF")[] {
    const studentSideOnly = p.roles.every((r) => STUDENT_SIDE_ROLES.has(r));
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
