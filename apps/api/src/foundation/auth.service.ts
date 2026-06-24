import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
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
}

// A valid bcrypt hash of a random string — compared against when the user is not
// found, so login takes ~the same time either way (mitigates user enumeration).
const DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8DkuErEr2Q9p0a8b8a8b8a8b8a8b8a";

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

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
          select: { failedLoginCount: true, lockedUntil: true, mfaEnabled: true, mfaSecret: true },
        });

        if (sec?.lockedUntil && sec.lockedUntil > new Date()) {
          return { status: "LOCKED" as const };
        }

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) {
          const fails = (sec?.failedLoginCount ?? 0) + 1;
          const lockedUntil =
            fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
          await tx.user.update({
            where: { id: user.id },
            data: { failedLoginCount: fails, lockedUntil },
          });
          return { status: "BAD_PASSWORD" as const };
        }

        if (sec?.mfaEnabled) {
          if (!mfaCode || !sec.mfaSecret || !verifyTotp(sec.mfaSecret, mfaCode)) {
            return { status: "MFA_REQUIRED" as const };
          }
        }

        // Success: clear the lockout counters and resolve the claims.
        await tx.user.update({
          where: { id: user.id },
          data: { failedLoginCount: 0, lockedUntil: null },
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
        const school = await tx.school.findUnique({ where: { id: user.school_id } });
        return {
          status: "OK" as const,
          result: {
            userId: user.id,
            schoolId: user.school_id,
            schoolName: school?.name ?? "",
            name: user.name,
            roles,
            permissions,
          },
        };
      },
    );

    if (outcome.status === "LOCKED") {
      throw new UnauthorizedException("Account locked — try again later");
    }
    if (outcome.status === "BAD_PASSWORD") throw new UnauthorizedException("Invalid credentials");
    if (outcome.status === "MFA_REQUIRED") throw new UnauthorizedException("MFA_REQUIRED");
    // Resolve the school's subscription-enabled modules (outside the login tx) so
    // the web can hide modules the plan doesn't include.
    const modules = await this.modules.effectiveModules(outcome.result.schoolId);
    return { ...outcome.result, modules };
  }
}
