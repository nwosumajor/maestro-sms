import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { prisma } from "@sms/db";
import { effectivePermissions, resolveRegion } from "@sms/types";
import { verifyTotp } from "../auth/totp";
import { ModuleEntitlementService } from "./module-entitlement.service";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { type AuditLogService } from "./audit-log.service";

/** The three region facts the web needs to format identically on server and
 *  client. Derived from the school row through the same resolver the API uses, so
 *  a school with nothing set gets the platform's home region — unchanged. */
function regionClaims(school: { country?: string | null; timezone?: string | null; locale?: string | null; currency?: string | null } | null) {
  const r = resolveRegion(school ?? {});
  return { timezone: r.timezone, locale: r.locale, currency: r.currency };
}

export interface LoginResult {
  userId: string;
  schoolId: string;
  schoolName: string;
  name: string;
  roles: string[];
  permissions: string[];
  /** The school's subscription-enabled modules — drives the web nav. */
  modules: string[];
  /** WHERE THE SCHOOL IS — IANA zone, BCP-47 locale, ISO fee currency. Carried in
   *  the session because the web must format identically during the server render
   *  and the client hydration: a runtime-default locale differs between Node and
   *  the browser, which is a React hydration mismatch, not a cosmetic difference.
   *  Three short strings; the session cookie has ample headroom. */
  timezone: string;
  locale: string;
  currency: string;
  /** super_admin mandated MFA but the user hasn't enrolled — web forces /account. */
  mfaEnrollRequired: boolean;
  /** Password is older than the max age (or admin-reset) — web forces a change. */
  passwordExpired: boolean;
  /** Epoch ms of the password this session was issued under; 0 when never set. */
  passwordChangedAtMs: number;
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

/**
 * How long a one-time TEMP PASSWORD stays usable if nobody uses it.
 *
 * The same 7 days as the invite link it accompanies, and for the same reason: an
 * unused credential that never goes stale is a standing password living in
 * whatever chat it was pasted into. Matching the link's life also means "the
 * invite expired" is ONE fact rather than two that can disagree.
 */
const TEMP_PASSWORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True when an unused temp password has gone stale.
 *
 * Only applies while the account has NEVER been activated (passwordChangedAt is
 * null). Once the user sets their own password this is irrelevant, and
 * `tempPasswordSetAt` is cleared anyway.
 *
 * NULL `tempPasswordSetAt` means UNLIMITED, not expired — those rows predate the
 * column and carry temp passwords issued under the old rules. Failing them closed
 * would lock out every not-yet-activated admin on an existing database, turning a
 * hardening change into an outage.
 */
export function isTempPasswordStale(
  tempPasswordSetAt: Date | null | undefined,
  passwordChangedAt: Date | null | undefined,
): boolean {
  if (passwordChangedAt) return false;
  if (!tempPasswordSetAt) return false;
  return Date.now() - tempPasswordSetAt.getTime() > TEMP_PASSWORD_MAX_AGE_MS;
}

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
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
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
            tempPasswordSetAt: true,
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
          // In the SAME transaction as the counter, so the record and the state
          // it describes cannot disagree — a lock with no entry explaining it is
          // exactly what an operator is left holding today.
          await this.audit.record(
            {
              actorId: user.id,
              action: nowLocked ? "auth.account.locked" : "auth.login.failed",
              entity: "user",
              entityId: user.id,
              schoolId: user.school_id,
              metadata: { failedLoginCount: fails, locked: nowLocked },
            },
            tx,
          );
          return nowLocked ? { status: "LOCKED" as const } : { status: "BAD_PASSWORD" as const };
        }

        // The password is CORRECT. If it is a temp credential that was never used
        // and has gone stale, refuse it here — after the match, so a stale
        // credential does not consume a failed-login attempt or lock the account,
        // and before any session is granted.
        if (isTempPasswordStale(sec?.tempPasswordSetAt, sec?.passwordChangedAt)) {
          return { status: "TEMP_EXPIRED" as const };
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

        // Success: clear the failure counters, stamp the sign-in, resolve claims.
        await tx.user.update({
          where: { id: user.id },
          data: { failedLoginCount: 0, locked: false, lockedUntil: null, lastLoginAt: new Date() },
        });
        // The answer to "when did they get in?". The security-incident runbook
        // sends an on-call engineer to audit_log to work out what a stolen
        // credential touched; without this the trail begins after the sign-in.
        await this.audit.record(
          { actorId: user.id, action: "auth.login", entity: "user", entityId: user.id, schoolId: user.school_id },
          tx,
        );
        const userRoles = await tx.userRole.findMany({
          where: { userId: user.id },
          include: { role: { include: { permissions: { include: { permission: true } } } } },
        });
        const roles: string[] = userRoles.map((ur: { role: { name: string } }) => ur.role.name);
        const grantedPermissions: string[] = [
          ...new Set<string>(
            userRoles.flatMap((ur: { role: { permissions: { permission: { key: string } }[] } }) =>
              ur.role.permissions.map((rp) => rp.permission.key),
            ),
          ),
        ];
        // super_admin is EXEMPT from the 30-day reset policy.
        const passwordExpired = isPasswordExpired(sec?.passwordChangedAt, roles.includes("super_admin"));
        const school = await tx.school.findUnique({ where: { id: user.school_id } });
        // SECURITY (defence in depth): `platform.*` permissions are cross-tenant
        // reach and mean nothing outside the platform organisation. Filtering
        // here makes a platform-tier role attached to a SCHOOL user inert —
        // covering grants made before the assignment guard existed, hand-edited
        // rows, or a restored backup. AdminService blocks new grants; this
        // neutralises existing ones.
        const permissions = effectivePermissions(grantedPermissions, school?.isPlatform === true);
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
            ...regionClaims(school),
            mfaEnrollRequired,
            passwordExpired,
            // WHICH PASSWORD THIS SESSION WAS ISSUED UNDER.
            //
            // Carried so the refresh can revoke a session that predates a
            // password change. The reason someone changes their password is
            // usually that they believe somebody else has it — and until now
            // that action did nothing to the intruder, whose session simply went
            // on refreshing. Verified before the fix: session A stayed valid
            // through a password change and a full refresh cycle.
            passwordChangedAtMs: sec?.passwordChangedAt?.getTime() ?? 0,
          },
        };
      },
    );

    if (outcome.status === "LOCKED") {
      throw new UnauthorizedException("ACCOUNT_LOCKED");
    }
    if (outcome.status === "TEMP_EXPIRED") {
      // Said plainly, and distinctly from "wrong password": the person is holding
      // a credential that WAS right. Telling them it is invalid sends them to
      // reset-password, which cannot help — someone must re-issue the invite.
      throw new UnauthorizedException("TEMP_PASSWORD_EXPIRED");
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
  async refreshClaims(p: { userId: string; schoolId: string; passwordChangedAtMs?: number }): Promise<RefreshedClaims> {
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

        // A SESSION OLDER THAN THE CURRENT PASSWORD IS DEAD.
        //
        // `passwordChangedAtMs` rides the session from login. When the stored
        // password has moved on, every session issued under the previous one —
        // including an intruder's — is revoked on its next refresh, which is at
        // most a minute away. The session that DID the change is revoked too:
        // "you changed your password, sign in again" is the expected and honest
        // outcome, and it is what makes the rule simple enough to trust.
        //
        // A session minted before this claim existed carries `undefined` and is
        // left alone rather than logged out en masse on deploy; it ages out
        // within the session lifetime anyway.
        if (p.passwordChangedAtMs !== undefined) {
          const current = u.passwordChangedAt?.getTime() ?? 0;
          if (current !== p.passwordChangedAtMs) return { revoked: true as const };
        }

        const school = await tx.school.findUnique({ where: { id: p.schoolId } });
        if (school?.status !== "ACTIVE" && !isSuperAdmin) return { revoked: true as const };

        const grantedPermissions: string[] = [
          ...new Set<string>(
            userRoles.flatMap((ur: { role: { permissions: { permission: { key: string } }[] } }) =>
              ur.role.permissions.map((rp) => rp.permission.key),
            ),
          ),
        ];
        // Same defence in depth as login: platform.* is inert outside the
        // platform org, so a stale grant cannot be re-acquired mid-session.
        const permissions = effectivePermissions(grantedPermissions, school?.isPlatform === true);
        return {
          revoked: false as const,
          claims: {
            schoolName: school?.name ?? "",
            roles,
            permissions,
            // Refreshed too, so moving a school's region takes effect on the next
            // session refresh rather than only at the next sign-in.
            ...regionClaims(school),
            mfaEnrollRequired: u.mfaRequired === true && !u.mfaEnabled,
            passwordExpired: isPasswordExpired(u.passwordChangedAt, isSuperAdmin),
            passwordChangedAtMs: u.passwordChangedAt?.getTime() ?? 0,
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
        // Clearing tempPasswordSetAt matters: the account now has a real
        // password, and leaving the marker would keep the staleness check looking
        // at a credential that no longer exists.
        data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, tempPasswordSetAt: null },
      });
      // Never the password, in any form — only that it changed, and when. An
      // attacker who takes an account changes this first, and the operator's own
      // reset (`operator.user.password_reset`) was already recorded while the
      // self-service one was not.
      await this.audit.record(
        { actorId: userId, action: "auth.password.changed", entity: "user", entityId: userId, schoolId },
        tx,
      );
    });
  }
}
