// =============================================================================
// PlatformAuditService — cross-tenant audit trail for the platform owner
// =============================================================================
// The super_admin oversees EVERY customer school. This surfaces the audit_log
// across all tenants so any change or approval — especially by a school's
// principal or school_admin — is attributable: each entry resolves the actor's
// email + unique id + roles, plus the school, and can be exported as CSV for
// investigation. Reads through the shared PRIVILEGED client (RLS-bypassing) like
// the other operator cross-tenant surfaces; the platform org is excluded. Every
// view/export is itself audited (meta-audit). 503 when no privileged URL.

import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { PlatformAuditEntryDto, PlatformAuditPageDto } from "@sms/types";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { decodeAuditCursor, encodeAuditCursor } from "../common/audit-cursor";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

export interface PlatformAuditFilter {
  schoolId?: string;
  /** Case-insensitive substring match on the actor's email. */
  actorEmail?: string;
  /** Only actions performed by users holding this role (e.g. principal, school_admin). */
  role?: string;
  /** Case-insensitive substring match on the action string. */
  action?: string;
  entity?: string;
  from?: string;
  to?: string;
  limit?: number;
  /** Opaque cursor (the id of the last row of the previous page) for keyset pagination. */
  cursor?: string;
}


@Injectable()
export class PlatformAuditService {
  private readonly logger = new Logger("PlatformAudit");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  /** A page of audit entries + a keyset cursor for the next page. */
  async list(p: Principal, f: PlatformAuditFilter): Promise<PlatformAuditPageDto> {
    const pageSize = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const entries = await this.query(f, pageSize);
    await this.auditMeta(p, "operator.audit.view", { count: entries.length, filter: f as Record<string, unknown> });
    // A full page implies there may be more — hand back the last row's key.
    const nextCursor = entries.length === pageSize ? encodeAuditCursor(entries[entries.length - 1]) : null;
    return { entries, nextCursor };
  }

  /** Core cross-tenant audit query (shared by paginated list + CSV export). */
  private async query(f: PlatformAuditFilter, take: number): Promise<PlatformAuditEntryDto[]> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Platform audit is not configured");

    // Customer schools only (never the platform org itself).
    const schools = await client.school.findMany({ where: { isPlatform: false }, select: { id: true, name: true } });
    const schoolName = new Map(schools.map((s) => [s.id, s.name]));
    const customerIds = schools.map((s) => s.id);

    // Narrow the actor set when filtering by role and/or email (both resolve to userIds).
    let actorIdFilter: string[] | null = null;
    if (f.role) {
      const roleRows = await client.userRole.findMany({
        where: { schoolId: { in: customerIds }, role: { name: f.role } },
        select: { userId: true },
      });
      actorIdFilter = [...new Set(roleRows.map((r) => r.userId))];
    }
    if (f.actorEmail) {
      const users = await client.user.findMany({
        where: { schoolId: { in: customerIds }, email: { contains: f.actorEmail, mode: "insensitive" } },
        select: { id: true },
      });
      const emailIds = new Set(users.map((u) => u.id));
      actorIdFilter = actorIdFilter ? actorIdFilter.filter((id) => emailIds.has(id)) : [...emailIds];
    }

    const where: Record<string, unknown> = {
      schoolId: f.schoolId && customerIds.includes(f.schoolId) ? f.schoolId : { in: customerIds },
    };
    if (actorIdFilter) where.actorId = { in: actorIdFilter.length ? actorIdFilter : ["__none__"] };
    if (f.action) where.action = { contains: f.action, mode: "insensitive" };
    if (f.entity) where.entity = f.entity;
    if (f.from || f.to) {
      where.createdAt = { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) };
    }

    // audit_log is partitioned on createdAt, so its key — and therefore any Prisma
    // cursor — is the COMPOSITE (id, createdAt). The token stays opaque.
    const cursor = decodeAuditCursor(f.cursor);
    const rows = await client.auditLog.findMany({
      where,
      // Stable keyset ordering (createdAt can tie; id breaks ties deterministically).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      ...(cursor ? { cursor: { id_createdAt: cursor }, skip: 1 } : {}),
    });

    // Resolve actors: email + uniqueId + name + roles.
    const actorIds = [...new Set(rows.map((r) => r.actorId))];
    const users = actorIds.length
      ? await client.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true, uniqueId: true } })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    const roleRows = actorIds.length
      ? await client.userRole.findMany({ where: { userId: { in: actorIds } }, select: { userId: true, role: { select: { name: true } } } })
      : [];
    const rolesByUser = new Map<string, string[]>();
    for (const r of roleRows) {
      const list = rolesByUser.get(r.userId) ?? [];
      list.push(r.role.name);
      rolesByUser.set(r.userId, list);
    }

    return rows.map((r) => {
      const u = userById.get(r.actorId);
      return {
        id: r.id,
        createdAt: r.createdAt,
        schoolId: r.schoolId,
        schoolName: schoolName.get(r.schoolId) ?? "—",
        actorId: r.actorId,
        actorName: u?.name ?? "system",
        actorEmail: u?.email ?? "—",
        actorUniqueId: u?.uniqueId ?? "—",
        actorRoles: [...new Set(rolesByUser.get(r.actorId) ?? [])],
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      };
    });
  }

  /** Same query, rendered as a CSV report for download. */
  async exportCsv(p: Principal, f: PlatformAuditFilter): Promise<{ csv: string; filename: string }> {
    // Export is the WHOLE filtered set (up to a hard cap), not a single page.
    const entries = await this.query({ ...f, cursor: undefined }, Math.min(Math.max(f.limit ?? 2000, 1), 2000));
    await this.auditMeta(p, "operator.audit.export", { count: entries.length });
    const header = ["Timestamp", "School", "Actor", "Email", "Unique ID", "Roles", "Action", "Entity", "Entity ID", "Details"];
    const lines = [header.map(csvCell).join(",")];
    for (const e of entries) {
      lines.push(
        [
          e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
          e.schoolName,
          e.actorName,
          e.actorEmail,
          e.actorUniqueId,
          e.actorRoles.join(" | "),
          e.action,
          e.entity,
          e.entityId ?? "",
          e.metadata ? JSON.stringify(e.metadata) : "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const stamp = new Date().toISOString().slice(0, 10);
    return { csv: lines.join("\r\n"), filename: `platform-audit-${stamp}.csv` };
  }

  /** Meta-audit the super_admin's own view/export under the operator's tenant (best-effort). */
  private async auditMeta(p: Principal, action: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
        this.audit.record({ actorId: p.userId, action, entity: "platform", entityId: "audit", schoolId: p.schoolId, metadata }, tx),
      );
    } catch (err) {
      this.logger.warn(`${action} audit failed (non-fatal): ${String(err)}`);
    }
  }
}

/** RFC-4180 CSV escaping + formula-injection defence. A cell beginning with a
 *  spreadsheet formula trigger (= + - @ tab CR) is prefixed with a single quote so
 *  Excel/Sheets treats it as text, not an executable formula (OWASP CSV injection). */
function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
