import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import { isElevatable, type ModuleKey } from "@sms/types";
import { PERMISSION_KEY } from "./require-permission.decorator";
import { MODULE_KEY } from "./require-module.decorator";
import { STEPUP_KEY } from "./require-stepup.decorator";
import { PUBLIC_KEY } from "./public.decorator";
import { verifyToken } from "./jwt";
import { verifyStepUp } from "./stepup";
import type { Principal } from "./principal";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { ModuleEntitlementService } from "../foundation/module-entitlement.service";
import { RolePermissionsService } from "../foundation/role-permissions.service";
import { TenantRateLimitService } from "../common/tenant-rate-limit.service";
import { requestContext } from "./request-context";

export interface AuthedRequest extends Request {
  principal?: Principal;
}

/**
 * Global guard: authenticates every request from the Bearer JWT, attaches the
 * Principal, and enforces any @RequirePermission on the handler. Tenant isolation
 * (RLS) is applied later, per-transaction, from the same Principal — so this is
 * one of the three layers, never the only one.
 *
 * When the handler's required permission is NOT in the JWT, the guard makes ONE
 * last check: is there an ACTIVE, unexpired Just-In-Time elevation grant for that
 * exact permission? If so the request is allowed AND the elevated use is
 * audit-logged. This keeps elevation OUT of the long-lived token while still
 * additive to role permissions.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly modules: ModuleEntitlementService,
    private readonly rolePerms: RolePermissionsService,
    private readonly rateLimit: TenantRateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const principal = this.authenticate(req);
    // Slim bearers carry ROLES only (the web no longer ships the ~97-permission
    // array in the session cookie / bearer — it blew past proxy header buffers).
    // Expand roles → permissions here from the cached seeded tables. Back-compat:
    // a bearer that DOES carry permissions (older sessions, operator
    // impersonation tokens) is honoured unchanged.
    if (principal.permissions.length === 0 && principal.roles.length > 0) {
      principal.permissions = await this.rolePerms.forRoles(principal.roles);
    }
    req.principal = principal;

    // Record the real actor for the audit log. This is the ONLY place the token
    // has been verified, so it is the only place allowed to assert it.
    if (principal.impersonatedBy) {
      const store = requestContext.getStore();
      if (store) store.impersonatedBy = principal.impersonatedBy;
    }

    // Per-tenant rate limit — BEFORE the module/permission DB work, so a flooding
    // tenant is rejected cheaply. Keyed on the JWT school_id; fails OPEN if Redis
    // is down. Noisy-neighbor isolation: one school's budget never touches another's.
    const rl = await this.rateLimit.consume(principal.schoolId);
    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader("X-RateLimit-Limit", rl.limit);
    res.setHeader("X-RateLimit-Remaining", rl.remaining);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.resetMs / 1000));
      throw new HttpException("Rate limit exceeded for this school — retry shortly.", HttpStatus.TOO_MANY_REQUESTS);
    }

    // Module-entitlement gate: if this route belongs to a subscription module the
    // school's plan doesn't include, it doesn't exist for them → 404 (never-leak).
    // Orthogonal to permission; untagged routes are never module-gated.
    const requiredModule = this.reflector.getAllAndOverride<ModuleKey | undefined>(MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredModule && !(await this.modules.isEnabled(principal.schoolId, requiredModule))) {
      throw new NotFoundException();
    }

    const required = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Permission gate: role permission, or an active JIT elevation grant.
    if (
      required &&
      !principal.permissions.includes(required) &&
      !(await this.hasActiveGrant(principal, required))
    ) {
      throw new ForbiddenException();
    }

    // Step-up gate: the most sensitive routes also need a fresh re-auth token.
    const needsStepUp = this.reflector.getAllAndOverride<boolean>(STEPUP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (needsStepUp) {
      const token = req.headers["x-stepup"];
      if (!token || !verifyStepUp(String(token), principal.userId, principal.schoolId)) {
        throw new ForbiddenException("STEPUP_REQUIRED");
      }
    }
    return true;
  }

  private authenticate(req: AuthedRequest): Principal {
    // The ONLY way to authenticate: a verified Bearer JWT. The Principal's
    // school_id/roles/permissions come solely from the signed token (Golden
    // Rule #3) — never from a header, body, or query param.
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      return verifyToken(header.slice("Bearer ".length));
    }
    throw new UnauthorizedException("Missing bearer token");
  }

  /** True if an ACTIVE, unexpired grant for `permission` exists; audits the use. */
  private async hasActiveGrant(principal: Principal, permission: string): Promise<boolean> {
    // SECURITY: platform/cross-tenant + maker-checker permissions are NEVER
    // honoured from a JIT grant, even if an ACTIVE row exists (legacy/tampered).
    // They must come from the verified JWT. Mirrors the request-time check.
    if (!isElevatable(permission)) return false;
    try {
      return await this.db.runAsTenant(
        { schoolId: principal.schoolId, userId: principal.userId },
        async (tx) => {
          const grant = await tx.privilegeGrant.findFirst({
            where: {
              userId: principal.userId,
              permission,
              status: "ACTIVE",
              expiresAt: { gt: new Date() },
            },
            select: { id: true },
          });
          if (!grant) return false;
          await this.audit.record(
            {
              actorId: principal.userId,
              action: "security.elevation.used",
              entity: "privilege_grant",
              entityId: grant.id,
              schoolId: principal.schoolId,
              metadata: { permission },
            },
            tx,
          );
          return true;
        },
      );
    } catch {
      // Fail closed: any error checking elevation denies access.
      return false;
    }
  }
}
