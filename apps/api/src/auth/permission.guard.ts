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
import { isDelegatablePlatformPermission, isElevatable, type ModuleKey } from "@sms/types";
import { PERMISSION_KEY } from "./require-permission.decorator";
import { MODULE_KEY } from "./require-module.decorator";
import { STEPUP_KEY } from "./require-stepup.decorator";
import { PUBLIC_KEY } from "./public.decorator";
import { verifyToken } from "./jwt";
import { verifyStepUp } from "./stepup";
import { hasLiveDelegation } from "./platform-delegation.util";
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
    // SECURITY: modules gate what a CUSTOMER school has paid for. The platform
    // operator is not a customer — their org has no subscription, so resolving
    // it would fail-closed and 404 the super_admin-only surfaces that happen to
    // live inside a module (e.g. the cross-school Ultimate arena admin). The
    // bypass is role-keyed to the real operator: an IMPERSONATION token carries
    // the TARGET user's roles, so impersonated sessions still see exactly what
    // that school's plan enables.
    const isOperator = principal.roles.includes("super_admin");
    if (requiredModule && !isOperator && !(await this.modules.isEnabled(principal.schoolId, requiredModule))) {
      throw new NotFoundException();
    }

    const declared = this.reflector.getAllAndOverride<string | string[] | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // One string or several — several mean ANY one of them opens the route.
    const accepted = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
    // ELEVATION IS ADDITIVE TO THE JWT — which it was not. The gate below
    // honoured a grant, and nothing else did: `principal.permissions` still held
    // only the role permissions, so every service that re-checks it (the
    // approval engine, the approvals inbox, the stale-register edit, content
    // approval, subject selection) refused an elevated holder.
    //
    // The approval chains showed it worst. The decide ROUTE requires the generic
    // `workflow.review`, which a school_admin already holds, so the gate passed
    // on the JWT and never consulted grants at all — then the engine checked the
    // GRANULAR `workflow.review.principal` and answered "You are not the
    // Principal (final) approver". An active, audited, correctly-issued grant
    // was inert for the six chains that end at the principal.
    //
    // Merging here rather than at fourteen call sites: the guard is where the
    // JWT is verified and the only place that can speak for all of them.
    const jwtPermissions = principal.permissions;
    const granted = await this.activeGrantPermissions(principal);
    if (granted.length) {
      principal.permissions = [...new Set([...principal.permissions, ...granted])];
      principal.elevated = granted;
    }

    // Permission gate, in order of decreasing durability: the role permission in the
    // verified JWT, then an active JIT elevation grant (bottom-up, never platform.*),
    // then a live owner-granted platform delegation (top-down, delegable subset only).
    let satisfiedBy: string | undefined;
    for (const perm of accepted) {
      if (principal.permissions.includes(perm) || (await this.hasPlatformDelegation(principal, perm))) {
        satisfiedBy = perm;
        break;
      }
    }
    if (accepted.length && !satisfiedBy) {
      throw new ForbiddenException();
    }
    // Audit the elevated use where the grant is what let this route through —
    // unchanged in meaning, but now asked AFTER the merge, so it reports the
    // grant that mattered rather than re-querying for it.
    if (satisfiedBy && granted.includes(satisfiedBy) && !jwtPermissions.includes(satisfiedBy)) {
      await this.recordElevatedUse(principal, satisfiedBy);
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

  /**
   * True if the platform OWNER has lent this duty to this manager and it is still
   * live. Read from the DB on every miss rather than from the token, which is what
   * makes a hand-back take effect immediately instead of whenever a session expires.
   *
   * Restricted to DELEGABLE_PLATFORM_PERMISSIONS at the service — impersonation,
   * pricing, credentials and student PII are not lendable at any duration, and that
   * is re-checked here rather than trusted from the row.
   */
  private async hasPlatformDelegation(principal: Principal, permission: string): Promise<boolean> {
    // Cheap exit for the overwhelmingly common case: this is a per-request DB read,
    // and almost every permission in the product is not a lendable platform duty.
    if (!isDelegatablePlatformPermission(permission)) return false;
    try {
      // `=== true` rather than the raw result: this admits a request, so it
      // must be a boolean and not merely truthy. A tenant runner handing back
      // any other shape denies, which is the safe direction.
      const allowed = await this.db.runAsTenant(
        { schoolId: principal.schoolId, userId: principal.userId },
        async (tx) => {
          const held = await hasLiveDelegation(tx, principal.userId, permission);
          if (!held) return false;
          // Audited at USE, not merely at grant: "who had the duty" is a weaker
          // question than "what did they do with it".
          await this.audit.record(
            {
              actorId: principal.userId,
              action: "platform.delegation.use",
              entity: "permission",
              entityId: permission,
              schoolId: principal.schoolId,
              metadata: { permission },
            },
            tx,
          );
          return true;
        },
      );
      return allowed === true;
    } catch {
      // A failed lookup denies. Delegation is additive: falling back to "no" leaves
      // the caller exactly where their JWT put them.
      return false;
    }
  }

  /** True if an ACTIVE, unexpired grant for `permission` exists; audits the use. */
  /**
   * Every ELEVATABLE permission this user currently holds by an active grant.
   *
   * One indexed read per authenticated request. It replaces a per-permission
   * lookup that only ever asked about the ONE permission a route required —
   * which is why a grant for a permission checked deeper in a service was never
   * seen at all.
   *
   * SECURITY: platform/cross-tenant and maker-checker permissions are NEVER
   * honoured from a grant, even if an ACTIVE row exists (legacy or tampered).
   * They must come from the verified JWT. Filtered here so a non-elevatable
   * permission cannot enter `principal.permissions` by this route either — the
   * merge would otherwise be a way around `isElevatable`.
   */
  private async activeGrantPermissions(principal: Principal): Promise<string[]> {
    try {
      return await this.db.runAsTenant(
        { schoolId: principal.schoolId, userId: principal.userId },
        async (tx) => {
          const grants = await tx.privilegeGrant.findMany({
            where: {
              userId: principal.userId,
              status: "ACTIVE",
              expiresAt: { gt: new Date() },
            },
            select: { permission: true },
          });
          // Array.isArray rather than a cast: a tenant runner that returns
          // nothing must degrade to "no grants", not crash the gate for every
          // request. A `try` does not catch a wrong SHAPE.
          if (!Array.isArray(grants)) return [];
          return (grants as Array<{ permission: string }>)
            .map((g) => g.permission)
            .filter((perm) => typeof perm === "string" && isElevatable(perm));
        },
      );
    } catch {
      // Fail closed: an error resolving elevation grants nothing.
      return [];
    }
  }

  /** Record that a grant — not the JWT — is what admitted this request. */
  private async recordElevatedUse(principal: Principal, permission: string): Promise<void> {
    try {
      await this.db.runAsTenant(
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
          if (!grant) return;
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
        },
      );
    } catch {
      // Never let an audit failure deny a request the gate has already allowed.
    }
  }
}
