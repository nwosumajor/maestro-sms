// =============================================================================
// Message credits — reconcile what we charged against what the provider sent
// =============================================================================
// The platform is billed by the messaging provider PER MESSAGE and charges the
// school PER CREDIT. Nothing compared those two counts. The card rails have had
// a reconciliation sweep for exactly this shape of question since the payments
// program; the credit ledger — which is also money — had none, and could not
// have had one, because the Twilio adapter discarded the message SID.
//
// This sweep answers two questions and fixes one performance problem:
//
//   1. Did every credit we debited correspond to a message the provider
//      actually accepted? A debit with no provider id, or one the provider has
//      never heard of, is a school charged for nothing.
//   2. Did the provider send anything we did NOT debit? That is the platform
//      paying for a message it never charged for — the loss runs the other way,
//      and it is the one nobody notices.
//   3. It rewrites each school's CHECKPOINT from the FULL ledger, so the fast
//      balance read stays anchored to ground truth.
//
// The checkpoint is recomputed from the whole ledger every run, never from the
// previous checkpoint. That matters: a checkpoint derived from a checkpoint
// would inherit any drift for ever, which is precisely the failure a
// SUM-of-ledger balance exists to avoid. Recomputing makes drift self-healing —
// it can only exist between two runs.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { NotificationService } from "./notification.service";
import { NOTIFICATION_CHANNEL_PROVIDER, type NotificationChannelProvider } from "./notification.constants";

export interface CreditReconcileResult {
  /** Schools whose checkpoint was rewritten. */
  checkpointed: number;
  /** Debits in the window carrying no provider id — unverifiable. */
  unlinked: number;
  /** Debits whose provider id the provider does not recognise. */
  unknownToProvider: number;
  /** Messages the provider sent that we never debited — the platform's own loss. */
  uncharged: number;
  /** True when the sweep could not run at all — NOT a clean bill of health. */
  skipped?: "NO_DB" | "NO_PROVIDER";
}

/** How far back to compare. Providers expire message logs, and a window keeps
 *  the sweep's cost flat as the ledger grows for ever. */
const WINDOW_DAYS = 3;

@Injectable()
export class MessageCreditReconciliationService {
  private readonly logger = new Logger("CreditReconcile");

  constructor(
    private readonly db: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
    @Inject(NOTIFICATION_CHANNEL_PROVIDER) private readonly provider: NotificationChannelProvider,
  ) {}

  async sweep(trigger: "SCHEDULED" | "MANUAL" = "SCHEDULED"): Promise<CreditReconcileResult> {
    const client = this.db.client;
    if (!client) {
      // Distinguishable from "everything reconciled" — a sweep that could not
      // run must never read as a clean result.
      this.logger.warn("Credit reconciliation requested but no privileged DB — skipping.");
      return { checkpointed: 0, unlinked: 0, unknownToProvider: 0, uncharged: 0, skipped: "NO_DB" };
    }

    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
    const result: CreditReconcileResult = { checkpointed: 0, unlinked: 0, unknownToProvider: 0, uncharged: 0 };

    // --- 1. Rewrite every active school's checkpoint from the FULL ledger ----
    //
    // THIS IS A FULL-TABLE AGGREGATE AND THAT IS DELIBERATE. Measured at
    // 900,000 entries it is 165ms. Summing from the previous checkpoint instead
    // would make it O(a day) — and would make every checkpoint inherit any
    // drift in the one before it, for ever, which is the exact failure a
    // SUM-of-ledger balance exists to prevent. Correctness wins here because
    // this is a once-daily background job, not a request path; the READ side,
    // which does run per message, is bounded by the checkpoint this writes.
    // reason: groupBy's generated overload rejects a dynamically-shaped arg;
    // the shape is correct and the RESULT is typed here.
    const groupBy = client.messageCreditEntry.groupBy as unknown as (
      a: Record<string, unknown>,
    ) => Promise<Array<{ schoolId: string; _sum: { deltaCredits: number | null } }>>;
    const schools = await groupBy({ by: ["schoolId"], _sum: { deltaCredits: true } });

    for (const s of schools) {
      try {
        await client.messageCreditEntry.create({
          data: {
            schoolId: s.schoolId,
            // Zero delta: a checkpoint RECORDS the balance, it never changes it.
            // Anything else and the ledger would no longer sum to the truth.
            deltaCredits: 0,
            reason: "CHECKPOINT",
            balanceAfter: s._sum.deltaCredits ?? 0,
          },
        });
        result.checkpointed++;
      } catch (e) {
        this.logger.warn(`checkpoint failed for ${s.schoolId}: ${(e as Error).message}`);
      }
    }

    // --- 2. Compare our debits to the provider's own record -----------------
    if (!this.provider.listRecentMessages) {
      this.logger.log(
        `Credit reconciliation (${trigger}): checkpointed ${result.checkpointed}; ` +
          `provider cannot list messages, so charges were not verified.`,
      );
      return { ...result, skipped: "NO_PROVIDER" };
    }

    const debits = (await client.messageCreditEntry.findMany({
      where: { reason: "SEND", createdAt: { gte: since } },
      select: { id: true, schoolId: true, providerRef: true },
      take: 50_000,
    })) as unknown as Array<{ id: string; schoolId: string; providerRef: string | null }>;

    // A debit with no provider id cannot be checked either way. Counted rather
    // than ignored: it is the measure of how much of the ledger is verifiable,
    // and every send made before providerRef existed lands here.
    result.unlinked = debits.filter((d) => !d.providerRef).length;

    const sent = await this.provider.listRecentMessages(since).catch((e: unknown) => {
      this.logger.warn(`provider listing failed: ${(e as Error).message}`);
      return null;
    });
    if (!sent) return { ...result, skipped: "NO_PROVIDER" };

    const sentIds = new Set(sent.map((m: { providerRef: string }) => m.providerRef));
    const debitedIds = new Set(debits.map((d) => d.providerRef).filter(Boolean) as string[]);

    result.unknownToProvider = [...debitedIds].filter((id) => !sentIds.has(id)).length;
    result.uncharged = [...sentIds].filter((id) => !debitedIds.has(id)).length;

    if (result.unknownToProvider > 0 || result.uncharged > 0) {
      await this.alertOwners(client, result, sent.length, debitedIds.size);
    }

    this.logger.log(
      `Credit reconciliation (${trigger}): checkpointed=${result.checkpointed} ` +
        `debits=${debits.length} unlinked=${result.unlinked} ` +
        `unknownToProvider=${result.unknownToProvider} uncharged=${result.uncharged}`,
    );
    return result;
  }

  /** Best-effort: a failed alert must not fail the sweep that found the problem. */
  private async alertOwners(
    client: NonNullable<PrivilegedDatabaseService["client"]>,
    r: CreditReconcileResult,
    providerCount: number,
    ourCount: number,
  ): Promise<void> {
    try {
      const owners = await client.user.findMany({
        where: { roles: { some: { role: { name: "super_admin" } } } },
        select: { id: true, schoolId: true },
      });
      for (const owner of owners) {
        await this.notifications.enqueue(
          { schoolId: owner.schoolId, userId: owner.id },
          {
            recipientId: owner.id,
            type: "OPERATOR_ALERT",
            title: `Message credits do not reconcile (${WINDOW_DAYS}d)`,
            body:
              `The provider records ${providerCount} message(s); we charged ${ourCount} credit(s) with a ` +
              `matching id.\n\n` +
              `• ${r.unknownToProvider} charged to a school with an id the provider does not recognise — ` +
              `those schools may have been charged for nothing.\n` +
              `• ${r.uncharged} sent by the provider with no matching charge — the platform paid for those.\n` +
              `• ${r.unlinked} debit(s) carry no provider id and cannot be checked either way.`,
            data: { ...r },
            channels: ["EMAIL"],
          },
        );
      }
    } catch (e) {
      this.logger.warn(`credit reconciliation alert failed: ${(e as Error).message}`);
    }
  }
}
