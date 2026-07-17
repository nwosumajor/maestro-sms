// =============================================================================
// PublicService — pre-auth website surface (school directory + onboarding intake)
// =============================================================================
// All reads/writes here are PUBLIC (no session). The School registry is global /
// RLS-exempt, so we resolve it under a placeholder GUC (never client-supplied
// tenant data). onboarding_request is likewise global (no schoolId); the public
// submit inserts via the least-privilege app role (SELECT/INSERT grant only).
// Nothing here can touch tenant-scoped student/user data.
// =============================================================================

import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { Prisma, prisma } from "@sms/db";
import { LEGAL_DOCS_VERSION, isModuleKey, isPlan, type PublicSchoolDto } from "@sms/types";
import {
  TENANT_DATABASE,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";
import { EmailService } from "../notifications/email.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { mintPasswordResetToken, verifyInviteToken, verifyPasswordResetToken } from "../auth/invite";

const ZERO = "00000000-0000-0000-0000-000000000000";

export interface OnboardingRequestInput {
  schoolName: string;
  schoolType?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  website?: string | null;
  studentCount?: number | null;
  staffCount?: number | null;
  ownerName?: string | null;
  ownerPhone?: string | null;
  contactName: string;
  contactRole?: string | null;
  contactEmail: string;
  contactPhone?: string | null;
  desiredSlug?: string | null;
  desiredPlan?: string | null;
  desiredModules?: string[] | null;
  currentSystem?: string | null;
  referralCode?: string | null;
  agentCode?: string | null;
  notes?: string | null;
}

@Injectable()
export class PublicService {
  private readonly logger = new Logger(PublicService.name);

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    private readonly notifications: NotificationService,
    private readonly email: EmailService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  /** PUBLIC: list onboarded (ACTIVE) schools for the parent directory. The
   *  admission-form fee is deliberately public — applicants must see the cost
   *  before they fill a five-minute form. */
  async listSchools(): Promise<PublicSchoolDto[]> {
    return this.db.runAsTenant({ schoolId: ZERO, userId: ZERO }, (tx) =>
      tx.school.findMany({
        where: { status: "ACTIVE", isPlatform: false },
        select: { id: true, name: true, slug: true, admissionFormFeeMinor: true },
        orderBy: { name: "asc" },
      }),
    );
  }

  /** PUBLIC: a prospective principal asks to onboard their school. Records the
   *  requested plan/modules as a WISH (operator decides at provisioning) and
   *  alerts every platform owner in-app — a request must never sit unseen. */
  async submitOnboardingRequest(input: OnboardingRequestInput) {
    const desiredSlug = input.desiredSlug?.trim().toLowerCase() || null;
    // Sanitise the wish: only a real tier / real module keys survive (the values
    // come from an unauthenticated form — never trust them shapes-deep).
    const desiredPlan = input.desiredPlan && isPlan(input.desiredPlan) ? input.desiredPlan : null;
    const desiredModules = (input.desiredModules ?? []).filter(isModuleKey);
    // Referral code: stored as a RAW string (normalised) — resolved to its
    // owning school only at provisioning, on the privileged client. An invalid
    // code just resolves to nothing; it can't block a signup.
    const rawReferral = input.referralCode?.trim().toUpperCase() ?? "";
    const referralCode = /^[A-Z0-9-]{4,40}$/.test(rawReferral) ? rawReferral : null;
    const rawAgent = input.agentCode?.trim().toUpperCase() ?? "";
    const agentCode = /^[A-Z0-9-]{3,40}$/.test(rawAgent) ? rawAgent : null;
    const created = await this.db.runAsTenant({ schoolId: ZERO, userId: ZERO }, (tx) =>
      tx.onboardingRequest.create({
        data: {
          schoolName: input.schoolName,
          schoolType: input.schoolType ?? null,
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          website: input.website?.trim() || null,
          studentCount: input.studentCount ?? null,
          staffCount: input.staffCount ?? null,
          ownerName: input.ownerName ?? null,
          ownerPhone: input.ownerPhone ?? null,
          contactName: input.contactName,
          contactRole: input.contactRole ?? null,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone ?? null,
          desiredSlug,
          desiredPlan,
          desiredModules: desiredModules.length > 0 ? (desiredModules as Prisma.InputJsonValue) : Prisma.JsonNull,
          currentSystem: input.currentSystem?.trim() || null,
          referralCode,
          agentCode,
          // Clickwrap evidence: the schema requires legalAccepted === true, so
          // every stored request carries the pack version in force at submit.
          legalVersion: LEGAL_DOCS_VERSION,
          notes: input.notes ?? null,
          status: "NEW",
        },
        select: { id: true, status: true },
      }),
    );
    const summary = [
      desiredPlan ? `${desiredPlan} plan` : null,
      input.studentCount ? `~${input.studentCount} students` : null,
      input.state ? `${input.city ? `${input.city}, ` : ""}${input.state}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    await this.notifyPlatformOwners(created.id, input.schoolName, summary);
    // Acknowledge the REQUESTER by email (they have no account yet, so this is a
    // direct send). Best-effort — the request row is already saved.
    await this.email.send(
      input.contactEmail,
      `We received your onboarding request for ${input.schoolName}`,
      `Hello ${input.contactName},\n\n` +
        `Thank you for requesting to bring ${input.schoolName} onto the SMS platform` +
        `${desiredPlan ? ` on the ${desiredPlan} plan` : ""}. Our team reviews every request ` +
        `and will get back to you within 1–2 working days.\n\n— The SMS Platform team`,
    );
    return created;
  }

  /**
   * PUBLIC: accept a provisioning invite — set the account's FIRST password.
   * The signed token (7-day expiry) identifies the account; single-use is
   * enforced by only honouring it while the account has NEVER set a password
   * (passwordChangedAt IS NULL — exactly the forced-first-reset state every
   * provisioned admin starts in). One generic error for every failure mode so
   * the endpoint never confirms which accounts/tokens exist.
   */
  async acceptInvite(token: string, password: string): Promise<{ ok: true; email: string; schoolSlug: string }> {
    const invite = verifyInviteToken(token);
    if (!invite) throw new BadRequestException("This invite link is invalid or has expired");
    // Hash OUTSIDE the tenant tx (bcrypt is slow; keep the interactive tx fast).
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await this.db.runAsTenant(
      { schoolId: invite.schoolId, userId: invite.userId },
      async (tx) => {
        const user = await tx.user.findFirst({
          where: { id: invite.userId },
          select: { id: true, email: true, passwordChangedAt: true, status: true },
        });
        if (!user || user.status !== "ACTIVE" || user.passwordChangedAt !== null) return null;
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash, passwordChangedAt: new Date() },
        });
        const school = await tx.school.findFirst({ where: { id: invite.schoolId }, select: { slug: true } });
        return { email: user.email, schoolSlug: school?.slug ?? "" };
      },
    );
    if (!result) throw new BadRequestException("This invite link is invalid or has expired");
    return { ok: true, ...result };
  }

  /**
   * PUBLIC: "forgot password" — email a 30-minute single-use reset link.
   * ALWAYS answers ok (whether or not the email exists — no account oracle).
   * The lookup reuses the SECURITY DEFINER login function, so the app role can
   * find the account across tenants without weakening RLS.
   */
  async requestPasswordReset(email: string): Promise<{ ok: true }> {
    try {
      const rows = await prisma.$queryRaw<
        Array<{ id: string; school_id: string; status: string; name: string }>
      >`SELECT * FROM app_login_lookup(${email})`;
      const user = rows[0];
      if (!user || user.status !== "ACTIVE") return { ok: true };
      const detail = await this.db.runAsTenant({ schoolId: user.school_id, userId: user.id }, async (tx) => {
        const u = await tx.user.findFirst({ where: { id: user.id }, select: { passwordChangedAt: true } });
        const school = await tx.school.findFirst({ where: { id: user.school_id }, select: { slug: true } });
        return { passwordChangedAt: u?.passwordChangedAt ?? null, slug: school?.slug ?? "" };
      });
      const base = process.env.PUBLIC_WEB_URL ?? "http://localhost:3000";
      const link = `${base}/reset-password?token=${encodeURIComponent(
        mintPasswordResetToken(user.id, user.school_id, detail.passwordChangedAt),
      )}`;
      await this.email.send(
        email,
        "Reset your SMS password",
        `Hello ${user.name},\n\nUse this link to set a new password (valid for 30 minutes, works once):\n\n` +
          `${link}\n\nIf you didn't request this, you can ignore this email — your password is unchanged.` +
          `\n\n— The SMS Platform team`,
      );
    } catch (err) {
      this.logger.warn(`password-reset request failed: ${(err as Error).message}`);
    }
    return { ok: true };
  }

  /** PUBLIC: apply a password reset. Single-use via the pca binding (see
   *  invite.ts); one generic error for every failure mode. NOTE: a permanently
   *  LOCKED account stays locked — reset changes the password, not the lock. */
  async confirmPasswordReset(token: string, password: string): Promise<{ ok: true; email: string; schoolSlug: string }> {
    const reset = verifyPasswordResetToken(token);
    if (!reset) throw new BadRequestException("This reset link is invalid or has expired");
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await this.db.runAsTenant({ schoolId: reset.schoolId, userId: reset.userId }, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: reset.userId },
        select: { id: true, email: true, status: true, passwordChangedAt: true },
      });
      if (!user || user.status !== "ACTIVE") return null;
      if ((user.passwordChangedAt?.getTime() ?? 0) !== reset.pca) return null; // used / superseded
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date() } });
      const school = await tx.school.findFirst({ where: { id: reset.schoolId }, select: { slug: true } });
      return { email: user.email, schoolSlug: school?.slug ?? "" };
    });
    if (!result) throw new BadRequestException("This reset link is invalid or has expired");
    return { ok: true, ...result };
  }

  /** Best-effort in-app alert to every super_admin. Failure must NEVER fail the
   *  public submit — the request row is already saved. Owners normally live in
   *  the isPlatform org (found under its GUC with the app role); if none are
   *  there (older seeds parked the owner in a demo school), fall back to a
   *  privileged GLOBAL role lookup and notify each owner in their own tenant. */
  private async notifyPlatformOwners(requestId: string, schoolName: string, summary: string): Promise<void> {
    try {
      let owners: { id: string; schoolId: string }[] = [];
      const platform = await this.db.runAsTenant({ schoolId: ZERO, userId: ZERO }, (tx) =>
        tx.school.findFirst({ where: { isPlatform: true }, select: { id: true } }),
      );
      if (platform) {
        const rows = await this.db.runAsTenant({ schoolId: platform.id, userId: ZERO }, (tx) =>
          tx.user.findMany({
            where: { roles: { some: { role: { name: "super_admin" } } } },
            select: { id: true },
          }),
        );
        owners = rows.map((r) => ({ id: r.id, schoolId: platform.id }));
      }
      if (owners.length === 0 && this.privileged.client) {
        const rows = await this.privileged.client.user.findMany({
          where: { roles: { some: { role: { name: "super_admin" } } } },
          select: { id: true, schoolId: true },
        });
        owners = rows;
      }
      for (const owner of owners) {
        // Actor = the recipient: the audit row's actorId is FK'd to a real user
        // and this event has no human actor (public form). Same constraint the
        // careers intake hit — never use a placeholder uuid as an audit actor.
        await this.notifications.enqueue(
          { schoolId: owner.schoolId, userId: owner.id },
          {
            recipientId: owner.id,
            type: "ONBOARDING_REQUEST",
            title: "New school onboarding request",
            body: `${schoolName} asked to join${summary ? ` (${summary})` : ""}. Review it in the operator console.`,
            data: { onboardingRequestId: requestId },
            channels: ["EMAIL"],
          },
        );
      }
    } catch (err) {
      this.logger.warn(`onboarding-request owner notification failed: ${(err as Error).message}`);
    }
  }
}
