// =============================================================================
// ReferralService — the referral growth loop on the billing engine
// =============================================================================
// A school (billing.manage) generates a shareable code; a prospective school
// quotes it on the public onboarding form; provisioning resolves it onto the
// new school's subscription (referredBySchoolId). When the referred school's
// FIRST paid subscription lands, `grantRewardsInTx` — called INSIDE the billing
// webhook transaction — gives BOTH sides one free term (REFERRAL_REWARD_MONTHS):
// the new school's period stacks a bonus term on top of what it just bought,
// and the referrer's currentPeriodEnd extends on their existing plan.
//
// Idempotency (money-adjacent, so belt and braces):
//   1. `referralRewardAt` is claimed with an optimistic updateMany(… IS NULL) —
//      a concurrent webhook retry loses the claim and skips.
//   2. school_referral_conversion.referredSchoolId is UNIQUE — the database
//      itself refuses a second reward for the same school, ever.
// Atomicity: both sides commit in ONE transaction; a crash rolls back both, and
// the gateway's webhook retry re-runs the whole grant.
// =============================================================================

import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  REFERRAL_REWARD_MONTHS,
  SUBSCRIPTION_STATUS,
  type ReferralConversionDto,
  type ReferralInfoDto,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { SYSTEM_ACTOR_ID } from "./billing.constants";

/** Who is told that the school earned a free term — the people who run it.
 *  Mirrors `GRANT_NOTICE_RECIPIENTS` in the dunning sweep: the same question,
 *  about the same subscription, deserves the same answer. */
const REWARD_NOTICE_RECIPIENTS = ["principal", "school_admin"] as const;

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** Human-shareable code: school-name prefix + 4 random base32 chars. */
export function genReferralCode(schoolName: string): string {
  const prefix =
    schoolName
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "")
      .slice(0, 10) || "SCHOOL";
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L lookalikes
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  return `${prefix}-${suffix}`;
}

/** Everything the webhook needs to notify both sides after commit. */
export interface ReferralGrant {
  referrerSchoolId: string;
  referrerSchoolName: string;
  /** The user who created the code — the reward notification recipient. */
  /** Everyone at the referring school who should hear about it. Never empty
   *  by design, but a school with no active leadership yields none. */
  referrerRecipientIds: string[];
  referrerPeriodEnd: Date;
  referredSchoolName: string;
  /** The paying school's period end INCLUDING the bonus term. */
  referredPeriodEnd: Date;
  rewardMonths: number;
}

@Injectable()
export class ReferralService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  /** The school's referral panel (code may be null until generated). */
  async getMine(p: Principal): Promise<ReferralInfoDto> {
    return this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, async (tx) => {
      const code = await tx.schoolReferralCode.findFirst({ where: { schoolId: p.schoolId } });
      const conversions = await tx.schoolReferralConversion.findMany({
        where: { schoolId: p.schoolId },
        orderBy: { createdAt: "desc" },
      });
      return { code: code?.code ?? null, conversions: conversions.map(toConversionDto) };
    });
  }

  /** Create the school's code if absent (billing.manage; audited). */
  async ensureCode(p: Principal): Promise<ReferralInfoDto> {
    return this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, async (tx) => {
      let code = await tx.schoolReferralCode.findFirst({ where: { schoolId: p.schoolId } });
      if (!code) {
        const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } });
        // The code is globally unique. RLS hides other tenants' codes, so
        // uniqueness is enforced ONLY by the DB constraint — on the (~1 in 10⁶,
        // same-prefix) collision the insert aborts the tx and surfaces as a
        // retryable conflict; the next click draws a fresh suffix.
        code = await tx.schoolReferralCode
          .create({
            data: { schoolId: p.schoolId, code: genReferralCode(school?.name ?? "SCHOOL"), createdById: p.userId },
          })
          .catch(() => {
            throw new ConflictException("That code was just taken — please try again");
          });
        await this.audit.record(
          {
            actorId: p.userId,
            action: "billing.referral.code.create",
            entity: "school_referral_code",
            entityId: code!.id,
            schoolId: p.schoolId,
            metadata: { code: code!.code },
          },
          tx,
        );
      }
      const conversions = await tx.schoolReferralConversion.findMany({
        where: { schoolId: p.schoolId },
        orderBy: { createdAt: "desc" },
      });
      return { code: code!.code, conversions: conversions.map(toConversionDto) };
    });
  }

  /**
   * Grant both term rewards. MUST be called inside the billing webhook's tenant
   * transaction (the PAYING school's GUC), after the paid extension was applied.
   * Returns null when the reward was already claimed (idempotent), else the
   * payload for post-commit notifications.
   *
   * SECURITY: this is the ONE place billing crosses a tenant boundary — the
   * referrer's subscription/ledger writes run by switching the transaction-local
   * RLS GUC to the referrer school and back (set_config(..., true), same
   * mechanism runAsTenant uses). Both write sets stay fully RLS-checked against
   * their own tenant; the switch happens only in this server-side code path,
   * driven by referredBySchoolId which was stamped by PRIVILEGED provisioning —
   * never by anything request-supplied.
   */
  async grantRewardsInTx(
    tx: TenantTx,
    input: {
      payingSchoolId: string;
      subscriptionId: string;
      referrerSchoolId: string;
      /** The paying school's currentPeriodEnd after the PAID extension. */
      paidPeriodEnd: Date;
      actorId: string;
    },
  ): Promise<ReferralGrant | null> {
    const now = new Date();
    const months = REFERRAL_REWARD_MONTHS;

    // 1. Claim the one-time reward on the PAYING school's subscription and stack
    //    their bonus term. Optimistic: a concurrent retry claims nothing.
    const referredPeriodEnd = addMonths(input.paidPeriodEnd, months);
    const claimed = await tx.schoolSubscription.updateMany({
      where: { id: input.subscriptionId, referralRewardAt: null },
      data: { referralRewardAt: now, currentPeriodEnd: referredPeriodEnd },
    });
    if (claimed.count === 0) return null;

    // School names come from the GLOBAL registry (RLS-exempt, SELECT-only).
    const [payingSchool, referrerSchool] = await Promise.all([
      tx.school.findFirst({ where: { id: input.payingSchoolId }, select: { name: true } }),
      tx.school.findFirst({ where: { id: input.referrerSchoolId }, select: { name: true } }),
    ]);

    await this.audit.record(
      {
        actorId: input.actorId,
        action: "billing.referral.reward.referred",
        entity: "school_subscription",
        entityId: input.subscriptionId,
        schoolId: input.payingSchoolId,
        metadata: { referrerSchoolId: input.referrerSchoolId, rewardMonths: months, newPeriodEnd: referredPeriodEnd },
      },
      tx,
    );

    // 2. Switch the tx-local tenant to the REFERRER and grant their term.
    await this.setTxTenant(tx, input.referrerSchoolId);
    try {
      const codeRow = await tx.schoolReferralCode.findFirst({ where: { schoolId: input.referrerSchoolId } });
      const referrerSub = await tx.schoolSubscription.findFirst({ where: { schoolId: input.referrerSchoolId } });
      const base =
        referrerSub?.currentPeriodEnd && referrerSub.currentPeriodEnd > now ? referrerSub.currentPeriodEnd : now;
      const referrerPeriodEnd = addMonths(base, months);
      if (referrerSub) {
        await tx.schoolSubscription.update({
          where: { id: referrerSub.id },
          // A free term is equivalent to a paid extension — good standing again.
          data: { currentPeriodEnd: referrerPeriodEnd, status: SUBSCRIPTION_STATUS.ACTIVE },
        });
      } else {
        await tx.schoolSubscription.create({
          data: { schoolId: input.referrerSchoolId, currentPeriodEnd: referrerPeriodEnd },
        });
      }
      const conversion = await tx.schoolReferralConversion.create({
        data: {
          id: randomUUID(),
          schoolId: input.referrerSchoolId,
          referredSchoolId: input.payingSchoolId,
          referredSchoolName: payingSchool?.name ?? "A school",
          rewardMonths: months,
          newPeriodEnd: referrerPeriodEnd,
        },
      });
      await this.audit.record(
        {
          actorId: SYSTEM_ACTOR_ID,
          action: "billing.referral.reward.referrer",
          entity: "school_referral_conversion",
          entityId: conversion.id,
          schoolId: input.referrerSchoolId,
          metadata: { referredSchoolId: input.payingSchoolId, rewardMonths: months, newPeriodEnd: referrerPeriodEnd },
        },
        tx,
      );
      return {
        referrerSchoolId: input.referrerSchoolId,
        referrerSchoolName: referrerSchool?.name ?? "your school",
        // WHO AT THE REFERRING SCHOOL IS TOLD.
        //
        // This was the code's creator ALONE. Measured live: a bursar generated
        // the code, later left, the school earned three free months — and the
        // one notice went to an EXITED account, so `persist` correctly dropped
        // every external channel (zero deliveries queued) and they could not
        // sign in to read the in-app row either. The school's own school_admin
        // and principal, both ACTIVE, were told nothing.
        //
        // Every OTHER billing notice — dunning, renewal, the grant-expiry
        // warning — already goes to the leadership ROLES with a `status:
        // ACTIVE` filter. This one did not. Same asymmetry, and this is the
        // notice about money the school has EARNED.
        referrerRecipientIds: await this.rewardRecipients(tx, input.referrerSchoolId, codeRow?.createdById ?? null),
        referrerPeriodEnd,
        referredSchoolName: payingSchool?.name ?? "the school",
        referredPeriodEnd,
        rewardMonths: months,
      };
    } finally {
      // 3. ALWAYS restore the paying school's tenant for the rest of the tx.
      await this.setTxTenant(tx, input.payingSchoolId);
    }
  }

  /**
   * Who hears that the school earned a free term.
   *
   * The people who RUN the school, plus the person who did the referring if
   * they are still there — the same set and the same `status: ACTIVE` filter
   * every other billing notice already uses. A leaver is excluded rather than
   * merely deprioritised: `NotificationService.persist` drops every external
   * channel for a non-ACTIVE recipient and they cannot sign in to read the
   * in-app row, so addressing one is addressing nobody.
   *
   * Runs under the REFERRER's tenant — the caller has already switched.
   */
  private async rewardRecipients(tx: TenantTx, schoolId: string, codeCreatorId: string | null): Promise<string[]> {
    const leaders = (await tx.user.findMany({
      where: {
        schoolId,
        status: "ACTIVE",
        roles: { some: { role: { name: { in: [...REWARD_NOTICE_RECIPIENTS] } } } },
      },
      select: { id: true },
    })) as Array<{ id: string }>;
    const ids = new Set(leaders.map((l) => l.id));
    if (codeCreatorId) {
      // The person who did the referring, but only if they are still here — the
      // same question, asked of them as of everyone else.
      const creator = (await tx.user.findFirst({
        where: { id: codeCreatorId, status: "ACTIVE" },
        select: { id: true },
      })) as { id: string } | null;
      if (creator) ids.add(creator.id);
    }
    return [...ids];
  }

  /** Transaction-local RLS tenant switch (see the SECURITY note above). */
  private async setTxTenant(tx: TenantTx, schoolId: string): Promise<void> {
    await tx.$queryRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
  }
}

function toConversionDto(r: {
  id: string;
  referredSchoolName: string;
  rewardMonths: number;
  newPeriodEnd: Date;
  createdAt: Date;
}): ReferralConversionDto {
  return {
    id: r.id,
    referredSchoolName: r.referredSchoolName,
    rewardMonths: r.rewardMonths,
    newPeriodEnd: r.newPeriodEnd,
    convertedAt: r.createdAt,
  };
}
