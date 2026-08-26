// =============================================================================
// Paying a school the fee money the platform is holding for it
// =============================================================================
// A parent's card payment made BEFORE the school registered a settlement bank
// lands in the PLATFORM's gateway account. The invoice is correctly PAID — the
// parent did pay — and the cash is the platform's to hand over. The school's
// fees page has shown that balance for a while, under the only instruction the
// product could offer:
//
//     "…then contact support to have this released."
//
// So the debt was visible and undischargeable. The number could only ever go
// up; nothing recorded that a transfer had happened; and the school and the
// platform reconciled it, if at all, in email.
//
// THIS DOES NOT MOVE MONEY, and says so. The transfer happens at a bank, by a
// person. What it does is make the transfer a RECORD: the operator states the
// amount, the bank's own reference and the date, and the held payments it
// covers are stamped with it — so the balance falls to zero because specific
// payments were discharged, not because somebody edited a total.
//
// APPEND-ONLY. A release asserts that money left a bank account on a date. A
// mistake is corrected by a further release, never by rewriting one, which is
// why rls/108 grants INSERT and SELECT and nothing else.
//
// The write runs through the ORDINARY tenant client with the GUC set to the
// target school — the same pattern as the message-credit comp lever — so RLS
// still frames it and the row lands in the school's own tenant, where the
// school can read its own release history and check it against its bank.
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SettlementReleaseDto, SettlementHoldingDto, SettlementHeldDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

@Injectable()
export class SettlementReleaseService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  /** What the platform still owes this school, and what it has already paid. */
  async holding(p: Principal, schoolId: string): Promise<SettlementHoldingDto> {
    return this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const held = await this.heldInTx(tx, schoolId);
      const releases = (await tx.platformSettlementRelease.findMany({
        where: { schoolId },
        orderBy: { releasedAt: "desc" },
        take: 50,
      })) as Array<{
        id: string;
        amountMinor: number;
        currency: string;
        paymentCount: number;
        reference: string;
        note: string | null;
        releasedAt: Date;
      }>;
      return {
        schoolId,
        held,
        releases: releases.map((r) => ({
          id: r.id,
          amountMinor: r.amountMinor,
          currency: r.currency,
          paymentCount: r.paymentCount,
          reference: r.reference,
          note: r.note,
          releasedAt: r.releasedAt,
        })),
      };
    });
  }

  /**
   * What is still owed: platform-settled payments not yet covered by a release.
   *
   * A SUM over unreleased rows rather than a stored total, so the balance cannot
   * drift from the payments it is made of.
   */
  private async heldInTx(tx: TenantTx, schoolId: string): Promise<SettlementHeldDto[]> {
    // A payment carries no currency of its own — the INVOICE does, per row, so
    // an NGN invoice stays NGN whatever the school later charges in. Read
    // through it rather than assuming the school's current currency, which
    // would misdescribe every older payment.
    const raw = (await tx.payment.findMany({
      where: { schoolId, settledToPlatform: true, status: "POSTED", kind: "PAYMENT", platformReleaseId: null },
      select: { id: true, amountMinor: true, invoice: { select: { currency: true } } },
    })) as Array<{ id: string; amountMinor: number; invoice: { currency: string } | null }>;
    const rows = raw.map((r) => ({ id: r.id, amountMinor: r.amountMinor, currency: r.invoice?.currency ?? null }));
    // Currency is per row on this ledger, so the ANSWER is per currency. It used
    // to be one scalar with `currency: null` whenever there were two — kobo
    // added to cents, printed under the platform's own symbol. The release path
    // already settled one currency at a time and was right; the read was not.
    const by = new Map<string, { currency: string; amountMinor: number; paymentCount: number }>();
    for (const r of rows) {
      if (!r.currency) continue;
      const e = by.get(r.currency) ?? { currency: r.currency, amountMinor: 0, paymentCount: 0 };
      e.amountMinor += r.amountMinor;
      e.paymentCount += 1;
      by.set(r.currency, e);
    }
    return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  }

  /**
   * Record that the platform has paid a school what it was holding.
   *
   * Discharges EVERY unreleased held payment in the named currency, in one
   * transaction, and stamps each with the release. Refuses when there is nothing
   * to release, so a duplicate press cannot create a second record of the same
   * transfer — the second attempt finds no unreleased payments and says so.
   */
  async release(
    p: Principal,
    schoolId: string,
    input: { reference: string; note?: string | null; currency?: string | null },
  ): Promise<SettlementHoldingDto> {
    const reference = input.reference.trim();
    if (reference.length < 3) {
      throw new BadRequestException("Enter the bank's reference for the transfer — a release without one is an assertion, not a record.");
    }
    const client = this.privileged.client;
    if (!client) throw new BadRequestException("Settlement release requires the privileged database configuration");
    const school = await client.school.findFirst({ where: { id: schoolId }, select: { id: true } });
    if (!school) throw new NotFoundException("School not found");

    await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const raw = (await tx.payment.findMany({
        where: { schoolId, settledToPlatform: true, status: "POSTED", kind: "PAYMENT", platformReleaseId: null },
        select: { id: true, amountMinor: true, invoice: { select: { currency: true } } },
      })) as Array<{ id: string; amountMinor: number; invoice: { currency: string } | null }>;
      const rows = raw.map((r) => ({ id: r.id, amountMinor: r.amountMinor, currency: r.invoice?.currency ?? null }));

      const currencies = [...new Set(rows.map((r) => r.currency).filter((c): c is string => !!c))];
      const currency = input.currency?.toUpperCase() ?? (currencies.length === 1 ? currencies[0] : null);
      if (rows.length === 0) throw new BadRequestException("There is nothing held for this school to release.");
      if (!currency) {
        throw new BadRequestException(
          `This school's held payments are in more than one currency (${currencies.join(", ")}). Release one currency at a time.`,
        );
      }
      const covered = rows.filter((r) => (r.currency ?? "") === currency);
      if (covered.length === 0) {
        throw new BadRequestException(`Nothing is held for this school in ${currency}.`);
      }
      const amountMinor = covered.reduce((n, r) => n + r.amountMinor, 0);

      const release = (await tx.platformSettlementRelease.create({
        data: {
          schoolId,
          amountMinor,
          currency,
          paymentCount: covered.length,
          reference,
          note: input.note ?? null,
          releasedById: p.userId,
        },
      })) as { id: string };

      // Stamp the payments this covers. In the SAME transaction as the release,
      // so a balance can never show discharged money with no record of where it
      // went, nor a release covering payments still counted as owed.
      await tx.payment.updateMany({
        where: { id: { in: covered.map((r) => r.id) } },
        data: { platformReleaseId: release.id },
      });

      await this.audit.record(
        {
          actorId: p.userId,
          action: "platform.settlement.release",
          entity: "school",
          entityId: schoolId,
          schoolId,
          metadata: { releaseId: release.id, amountMinor, currency, paymentCount: covered.length, reference },
        },
        tx,
      );
    });

    return this.holding(p, schoolId);
  }
}

export type { SettlementReleaseDto };

// =============================================================================
// Which currencies the card account can charge, and who is waiting on each
// =============================================================================
// Enabling a currency is a dashboard action nobody can take from here. Knowing
// WHICH ones to enable, and which schools are stuck behind each, is what turns
// that from a guess into a task — and it is the difference between a parent
// meeting an unexplained refusal at checkout and an operator seeing, on one
// screen, that eleven schools bill in GHS and the account cannot take it.
import { Injectable as CoverageInjectable } from "@nestjs/common";
import { PAYSTACK_CURRENCIES, countryProfile, type CurrencyCoverageDto } from "@sms/types";
import { PaystackService } from "../payments/paystack.service";

@CoverageInjectable()
export class CurrencyCoverageService {
  constructor(
    private readonly privileged: PrivilegedDatabaseService,
    private readonly paystack: PaystackService,
  ) {}

  async coverage(): Promise<CurrencyCoverageDto> {
    const merchant = await this.paystack.merchantCurrencies();
    const client = this.privileged.client;
    const schools = client
      ? ((await client.school.findMany({
          where: { isPlatform: false },
          select: { name: true, country: true, currency: true },
        })) as Array<{ name: string; country: string | null; currency: string | null }>)
      : [];

    // A school's billing currency is its own column when set, else the one its
    // COUNTRY implies — the same resolution the rest of the platform uses, so
    // this screen cannot disagree with what a school is actually charged in.
    const byCurrency = new Map<string, string[]>();
    for (const s of schools) {
      const currency = (s.currency ?? countryProfile(s.country).currency).toUpperCase();
      byCurrency.set(currency, [...(byCurrency.get(currency) ?? []), s.name]);
    }

    const rows = [...byCurrency.entries()]
      .map(([currency, names]) => ({
        currency,
        schoolCount: names.length,
        sample: names.slice(0, 3),
        // Unknown is NOT "no": an unreachable /balance must never be read as
        // every currency being unsupported.
        covered: merchant === null ? true : merchant.includes(currency),
        railSupports: (PAYSTACK_CURRENCIES as readonly string[]).includes(currency),
      }))
      // Worst first: the currencies with schools waiting on them.
      .sort((a, b) => Number(a.covered) - Number(b.covered) || b.schoolCount - a.schoolCount);

    return { merchantCurrencies: merchant ?? [], known: merchant !== null, rows };
  }
}
