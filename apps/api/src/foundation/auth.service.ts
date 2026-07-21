import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { prisma } from "@sms/db";
import { verifyTotp } from "../auth/totp";
import { ModuleEntitlementService } from "./module-entitlement.service";
import {
  TENANT_DATABASE,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

export interface LoginResult {
  userId: string;
  schoolId: string;
  schoolName: string;
  name: string;
  roles: string[];
  permissions: string[];
  /** The school's subscription-enabled modules — drives the web nav. */
  modules: string[];
  /** super_admin mandated MFA but the user hasn't enrolled — web forces /account. */
  mfaEnrollRequired: boolean;
  /** Password is older than the max age (or admin-reset) — web forces a change. */
  passwordExpired: boolean;
}

/** Fresh claims for an EXISTING session (GET /auth/refresh) — everything the
 *  web re-stamps onto the JWT mid-session. No credentials involved. */
export type RefreshedClaims = Omit<LoginResult, "userId" | "schoolId" | "name">;

// A valid bcrypt hash of a random string — compared against when the user is not
// found, so login takes ~the same time either way (mitigates user enumeration).
const DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8DkuErEr2Q9p0a8b8a8b8a8b8a8b8a";

// Lock the account on the 3rd consecutive miss; the lock is PERMANENT (only a
// super_admin can reactivate it — no auto-expiry)…
const MAX_FAILS = 3;
// …EXCEPT for super_admin accounts, whose lock AUTO-EXPIRES. // SECURITY: a
// permanent lock on the platform owner lets an attacker who merely knows the
// operator's email lock out the ONLY account able to unlock anyone — a
// platform-wide administrative DoS recoverable only by DB surgery. A 15-minute
// window still blunts brute force (3 guesses per 15 min, behind the login rate
// limit) without an unrecoverable failure mode.
const SUPER_ADMIN_LOCK_MS = 15 * 60 * 1000;
// Every non-super_admin must reset their password within this many days.
const PASSWORD_MAX_AGE_DAYS = 30;
const PASSWORD_MAX_AGE_MS = PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** True when a non-super_admin's password is null-dated or older than the max age. */
export function isPasswordExpired(passwordChangedAt: Date | null | undefined, isSuperAdmin: boolean): boolean {
  if (isSuperAdmin) return false;
  if (!passwordChangedAt) return true;
  return Date.now() - passwordChangedAt.getTime() > PASSWORD_MAX_AGE_MS;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    private readonly modules: ModuleEntitlementService,
  ) {}

  /**
   * Verify credentials and resolve the caller's roles + permissions. The email
   * lookup goes through the SECURITY DEFINER `app_login_lookup` function so the
   * least-privilege app role can find the user across tenants WITHOUT RLS leaking
   * other schools. Then, inside the user's tenant context (RLS-scoped), we:
   *   1. reject if the account is locked (too many recent failures),
   *   2. verify the password (incrementing the failure counter + locking on the
   *      Nth miss — those counter writes COMMIT, so we return a status and throw
   *      OUTSIDE the transaction rather than rolling it back),
   *   3. require a valid TOTP code if MFA is enabled,
   *   4. on success, reset the counters and return the JWT claims.
   */
  async login(email: string, password: string, mfaCode?: string): Promise<LoginResult> {
    const rows = await prisma.$queryRaw<
      Array<{ id: string; school_id: string; password_hash: string; status: string; name: string }>
    >`SELECT * FROM app_login_lookup(${email})`;
    const user = rows[0];

    if (!user || user.status !== "ACTIVE") {
      await bcrypt.compare(password, DUMMY_HASH); // equalize timing
      throw new UnauthorizedException("Invalid credentials");
    }

    const outcome = await this.db.runAsTenant(
      { schoolId: user.school_id, userId: user.id },
      async (tx: TenantTx) => {
        const sec = await tx.user.findUnique({
          where: { id: user.id },
          select: {
            failedLoginCount: true,
            locked: true,
            lockedUntil: true,
            mfaEnabled: true,
            mfaSecret: true,
            mfaRequired: true,
            passwordChangedAt: true,
          },
        });

        // Permanent lockout — only a super_admin can reactivate. For a
        // super_admin ACCOUNT the lock instead auto-expires after
        // SUPER_ADMIN_LOCK_MS (see the constant for why), then login proceeds.
        if (sec?.locked) {
          const isSuperAdmin = await tx.userRole.findFirst({
            where: { userId: user.id, role: { name: "super_admin" } },
            select: { id: true },
          });
          const lockExpired =
            isSuperAdmin &&
            sec.lockedUntil != null &&
            Date.now() - sec.lockedUntil.getTime() > SUPER_ADMIN_LOCK_MS;
          if (!lockExpired) return { status: "LOCKED" as const };
          await tx.user.update({
            where: { id: user.id },
            data: { failedLoginCount: 0, locked: false, lockedUntil: null },
          });
        }

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) {
          const fails = (sec?.failedLoginCount ?? 0) + 1;
          const nowLocked = fails >= MAX_FAILS;
          await tx.user.update({
            where: { id: user.id },
            data: {
              failedLoginCount: fails,
              locked: nowLocked,
              // Record WHEN it locked (for the operator view); no auto-expiry.
              lockedUntil: nowLocked ? new Date() : null,
            },
          });
          return nowLocked ? { status: "LOCKED" as const } : { status: "BAD_PASSWORD" as const };
        }

        if (sec?.mfaEnabled) {
          if (!mfaCode || !sec.mfaSecret || !verifyTotp(sec.mfaSecret, mfaCode)) {
            return { status: "MFA_REQUIRED" as const };
          }
        }

        // MFA-enrolment mandate: the account must enrol MFA. We do NOT block the
        // password login (the user needs a session to reach the MFA setup page —
        // blocking would lock them out permanently). Instead we flag the claim;
        // the web forces the user to /account until mfaEnabled becomes true.
        // Mandate sources: the per-user mfaRequired flag, OR the school's
        // requireStaffMfa policy for any STAFF member (computed below once roles
        // and the school row are known — mfaEnrollRequired is finalized there).
        let mfaEnrollRequired = sec?.mfaRequired === true && !sec?.mfaEnabled;

        // Success: clear the failure counters and resolve the claims.
        await tx.user.update({
          where: { id: user.id },
          data: { failedLoginCount: 0, locked: false, lockedUntil: null },
        });
        const userRoles = await tx.userRole.findMany({
          where: { userId: user.id },
          include: { role: { include: { permissions: { include: { permission: true } } } } },
        });
        const roles: string[] = userRoles.map((ur: { role: { name: string } }) => ur.role.name);
        const permissions: string[] = [
          ...new Set<string>(
            userRoles.flatMap((ur: { role: { permissions: { permission: { key: string } }[] } }) =>
              ur.role.permissions.map((rp) => rp.permission.key),
            ),
          ),
        ];
        // super_admin is EXEMPT from the 30-day reset policy.
        const passwordExpired = isPasswordExpired(sec?.passwordChangedAt, roles.includes("super_admin"));
        const school = await tx.school.findUnique({ where: { id: user.school_id } });
        // School policy: staff (any role but student/parent) must enrol MFA.
        // super_admin is exempt (the owner's lock/exempt posture elsewhere).
        const isStaff = roles.some((r) => r !== "student" && r !== "parent");
        if (school?.requireStaffMfa && isStaff && !roles.includes("super_admin") && !sec?.mfaEnabled) {
          mfaEnrollRequired = true;
        }
        // A manually-DISABLED school blocks ALL of its members' logins (the hard
        // deactivation lever — distinct from PAST_DUE, which only degrades
        // modules so the school can still reach /billing and pay). Checked AFTER
        // the password verified so failures don't oracle school state. The
        // platform owner is exempt — the operator can never lock themselves out.
        if (school?.status !== "ACTIVE" && !roles.includes("super_admin")) {
          return { status: "SCHOOL_SUSPENDED" as const };
        }
        return {
          status: "OK" as const,
          result: {
            userId: user.id,
            schoolId: user.school_id,
            schoolName: school?.name ?? "",
            name: user.name,
            roles,
            permissions,
            mfaEnrollRequired,
            passwordExpired,
          },
        };
      },
    );

    if (outcome.status === "LOCKED") {
      throw new UnauthorizedException("ACCOUNT_LOCKED");
    }
    if (outcome.status === "BAD_PASSWORD") throw new UnauthorizedException("Invalid credentials");
    if (outcome.status === "MFA_REQUIRED") throw new UnauthorizedException("MFA_REQUIRED");
    if (outcome.status === "SCHOOL_SUSPENDED") {
      throw new UnauthorizedException("SCHOOL_SUSPENDED");
    }
    // Resolve the school's subscription-enabled modules (outside the login tx) so
    // the web can hide modules the plan doesn't include.
    const modules = await this.modules.effectiveModules(outcome.result.schoolId);
    return { ...outcome.result, modules };
  }

  /**
   * Mid-session claim revalidation (GET /auth/refresh). The session JWT is
   * otherwise the sole claims source for its whole sliding lifetime — meaning a
   * role revocation, account disable/lock, or school suspension would not reach
   * an already-open session until re-login. The web's jwt callback calls this
   * periodically and re-stamps the returned claims, so revocation lands within
   * minutes instead of weeks.
   *
   * // SECURITY: throws UnauthorizedException("ACCOUNT_REVOKED") when the
   * principal must lose their session (deleted/disabled/locked user, suspended
   * school). The web kills the session ONLY on an explicit 401/403 — transient
   * network/5xx failures keep the existing claims (fail-open on availability,
   * fail-closed on revocation), so this can never cause login flapping when the
   * API is briefly unreachable. Mirrors login's checks minus the credential
   * verification; deliberately writes nothing (no counters, no audit spam at
   * one call per user per interval).
   */
  async refreshClaims(p: { userId: string; schoolId: string }): Promise<RefreshedClaims> {
    const outcome = await this.db.runAsTenant(
      { schoolId: p.schoolId, userId: p.userId },
      async (tx: TenantTx) => {
        const u = await tx.user.findUnique({
          where: { id: p.userId },
          select: {
            status: true,
            locked: true,
            lockedUntil: true,
            mfaEnabled: true,
            mfaRequired: true,
            passwordChangedAt: true,
          },
        });
        if (!u || u.status !== "ACTIVE") return { revoked: true as const };

        const userRoles = await tx.userRole.findMany({
          where: { userId: p.userId },
          include: { role: { include: { permissions: { include: { permission: true } } } } },
        });
        const roles: string[] = userRoles.map((ur: { role: { name: string } }) => ur.role.name);
        const isSuperAdmin = roles.includes("super_admin");

        // Locked = revoked, with the same super_admin auto-expiry the login path
        // honours (but WITHOUT clearing counters — this is a read-only check).
        if (u.locked) {
          const lockExpired =
            isSuperAdmin &&
            u.lockedUntil != null &&
            Date.now() - u.lockedUntil.getTime() > SUPER_ADMIN_LOCK_MS;
          if (!lockExpired) return { revoked: true as const };
        }

        const school = await tx.school.findUnique({ where: { id: p.schoolId } });
        if (school?.status !== "ACTIVE" && !isSuperAdmin) return { revoked: true as const };

        const permissions: string[] = [
          ...new Set<string>(
            userRoles.flatMap((ur: { role: { permissions: { permission: { key: string } }[] } }) =>
              ur.role.permissions.map((rp) => rp.permission.key),
            ),
          ),
        ];
        return {
          revoked: false as const,
          claims: {
            schoolName: school?.name ?? "",
            roles,
            permissions,
            mfaEnrollRequired: u.mfaRequired === true && !u.mfaEnabled,
            passwordExpired: isPasswordExpired(u.passwordChangedAt, isSuperAdmin),
          },
        };
      },
    );
    if (outcome.revoked) throw new UnauthorizedException("ACCOUNT_REVOKED");
    const modules = await this.modules.effectiveModules(p.schoolId);
    return { ...outcome.claims, modules };
  }

  /**
   * Change the caller's own password (self-service — used both voluntarily and to
   * satisfy the forced 30-day reset). Verifies the current password, rejects reuse
   * of the same password, and stamps passwordChangedAt so the reset clock restarts.
   */
  async changePassword(userId: string, schoolId: string, currentPassword: string, newPassword: string): Promise<void> {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException("New password must be at least 8 characters");
    }
    await this.db.runAsTenant({ schoolId, userId }, async (tx: TenantTx) => {
      const u = await tx.user.findUnique({ where: { id: userId }, select: { passwordHash: true, locked: true } });
      if (!u) throw new UnauthorizedException("Invalid credentials");
      if (u.locked) throw new UnauthorizedException("ACCOUNT_LOCKED");
      const ok = await bcrypt.compare(currentPassword, u.passwordHash);
      if (!ok) throw new UnauthorizedException("Current password is incorrect");
      if (await bcrypt.compare(newPassword, u.passwordHash)) {
        throw new BadRequestException("New password must differ from the current one");
      }
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0 },
      });
    });
  }
}
