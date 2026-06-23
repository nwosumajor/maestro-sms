// =============================================================================
// OperatorService — platform (super_admin) cross-tenant console + impersonation
// =============================================================================
// Only reachable with platform.operate (super_admin). Tenant counts are read by
// setting the RLS GUC to each school in turn (the server controls the GUC — never
// the client). Impersonation mints a short-lived token carrying the TARGET user's
// claims plus an `imp.by` field, and is loudly audit-logged. The minted token is
// the same HS256 shape the web BFF issues, so the API accepts it as a Bearer.
// =============================================================================

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import jwt from "jsonwebtoken";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const IMPERSONATION_TTL = 900; // 15 min

@Injectable()
export class OperatorService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Every tenant + a user count each. School registry is global/RLS-exempt. */
  async listTenants(p: Principal) {
    const schools = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.school.findMany({ select: { id: true, name: true, slug: true, status: true, createdAt: true }, orderBy: { name: "asc" } }),
    );
    const out = [];
    for (const s of schools as Array<{ id: string; name: string; slug: string; status: string; createdAt: Date }>) {
      const users = await this.db.runAsTenant({ schoolId: s.id, userId: p.userId }, (tx) => tx.user.count());
      out.push({ ...s, users });
    }
    return out;
  }

  /** Mint an audited impersonation token for a user in a (possibly other) tenant. */
  async impersonate(p: Principal, schoolId: string, userId: string) {
    const target = await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const u = await tx.user.findFirst({ where: { id: userId }, select: { id: true, name: true } });
      if (!u) throw new NotFoundException("Target user not found");
      const userRoles = await tx.userRole.findMany({
        where: { userId },
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      });
      const roles = (userRoles as Array<{ role: { name: string } }>).map((ur) => ur.role.name);
      const permissions = [
        ...new Set(
          (userRoles as Array<{ role: { permissions: { permission: { key: string } }[] } }>).flatMap((ur) =>
            ur.role.permissions.map((rp) => rp.permission.key),
          ),
        ),
      ];
      return { name: u.name, roles, permissions };
    });

    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new NotFoundException("Auth not configured");
    const token = jwt.sign(
      { userId, school_id: schoolId, roles: target.roles, permissions: target.permissions, imp: { by: p.userId } },
      secret,
      { algorithm: "HS256", expiresIn: IMPERSONATION_TTL },
    );

    // Audit in the OPERATOR's own tenant (actor FK is the operator).
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        { actorId: p.userId, action: "operator.impersonate", entity: "user", entityId: userId, schoolId: p.schoolId, metadata: { targetSchoolId: schoolId, targetName: target.name } },
        tx,
      ),
    );
    return { token, expiresIn: IMPERSONATION_TTL, target: { userId, name: target.name, roles: target.roles } };
  }
}
