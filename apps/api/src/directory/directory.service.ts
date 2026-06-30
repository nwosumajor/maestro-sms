// =============================================================================
// DirectorySearchService — people search & filter (role-scoped)
// =============================================================================
// One search surface, two postures:
//   - school_admin / principal: search ONLY their own school. Runs as the app
//     role inside the caller's tenant transaction, so RLS scopes every row.
//   - super_admin (platform.operate): search ACROSS ALL schools. Runs via a
//     PRIVILEGED client (DATABASE_MIGRATE_URL) that bypasses RLS by design — the
//     same pattern as the operator user directory; 503 when unconfigured.
// Filters: q (uniqueId / name / email), school name (super_admin), location
// (student profile city/state/country), role. Every search is audit-logged in the
// caller's tenant (student PII — Golden Rule #5).
// =============================================================================

import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import type { PersonSearchResultDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

export interface SearchFilters {
  q?: string;
  school?: string;
  location?: string;
  role?: string;
}

// A minimal structural view of the Prisma `user` delegate (works for both the app
// tenant tx and the privileged client).
interface UserDelegate {
  findMany(args: unknown): Promise<unknown>;
}

@Injectable()
export class DirectorySearchService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  private isSuperAdmin(p: Principal): boolean {
    return p.permissions.includes("platform.operate");
  }

  async search(p: Principal, filters: SearchFilters): Promise<PersonSearchResultDto[]> {
    const results = this.isSuperAdmin(p)
      ? await this.searchAllSchools(filters)
      : await this.searchOwnSchool(p, filters);
    // Audit the (PII) search in the caller's own tenant.
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        { actorId: p.userId, action: "directory.search", entity: "user", entityId: p.schoolId, schoolId: p.schoolId, metadata: { ...filters, count: results.length, scope: this.isSuperAdmin(p) ? "all" : "own" } },
        tx,
      ),
    );
    return results;
  }

  private async searchOwnSchool(p: Principal, filters: SearchFilters): Promise<PersonSearchResultDto[]> {
    return this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.run((tx as unknown as { user: UserDelegate }).user, filters, false),
    );
  }

  private async searchAllSchools(filters: SearchFilters): Promise<PersonSearchResultDto[]> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Cross-school search is not configured");
    return this.run(client.user as unknown as UserDelegate, filters, true);
  }

  /** Shared query over a `user` delegate. `withSchoolFilter` enables the school-name filter. */
  private async run(
    users: UserDelegate,
    filters: SearchFilters,
    withSchoolFilter: boolean,
  ): Promise<PersonSearchResultDto[]> {
    const insensitive = Prisma.QueryMode.insensitive;
    const where: Prisma.UserWhereInput = {};
    const and: Prisma.UserWhereInput[] = [];

    if (filters.q?.trim()) {
      const q = filters.q.trim();
      and.push({
        OR: [
          { uniqueId: { contains: q, mode: insensitive } },
          { name: { contains: q, mode: insensitive } },
          { email: { contains: q, mode: insensitive } },
        ],
      });
    }
    if (withSchoolFilter && filters.school?.trim()) {
      and.push({ school: { name: { contains: filters.school.trim(), mode: insensitive } } });
    }
    if (filters.location?.trim()) {
      const loc = filters.location.trim();
      and.push({
        studentProfile: {
          is: {
            OR: [
              { city: { contains: loc, mode: insensitive } },
              { state: { contains: loc, mode: insensitive } },
              { country: { contains: loc, mode: insensitive } },
            ],
          },
        },
      });
    }
    if (filters.role?.trim()) {
      and.push({ roles: { some: { role: { name: filters.role.trim() } } } });
    }
    // Never surface platform-org members (the super_admin) in people search — they
    // are not students/staff of any customer school.
    and.push({ school: { isPlatform: false } });
    if (and.length) where.AND = and;

    const rows = (await users.findMany({
      where,
      take: 100,
      orderBy: { name: "asc" },
      select: {
        id: true,
        uniqueId: true,
        name: true,
        email: true,
        status: true,
        schoolId: true,
        school: { select: { name: true } },
        roles: { select: { role: { select: { name: true } } } },
        studentProfile: { select: { city: true, state: true, country: true } },
      },
    })) as Array<{
      id: string;
      uniqueId: string;
      name: string;
      email: string;
      status: string;
      schoolId: string;
      school: { name: string } | null;
      roles: { role: { name: string } }[];
      studentProfile: { city: string | null; state: string | null; country: string | null } | null;
    }>;

    return rows.map((u) => {
      const pr = u.studentProfile;
      const location = pr
        ? [pr.city, pr.state, pr.country].filter(Boolean).join(", ") || null
        : null;
      return {
        userId: u.id,
        uniqueId: u.uniqueId,
        name: u.name,
        email: u.email,
        roles: u.roles.map((r) => r.role.name),
        status: u.status,
        schoolId: u.schoolId,
        schoolName: u.school?.name ?? "",
        location,
      };
    });
  }
}
