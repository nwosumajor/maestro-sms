// =============================================================================
// Notifications — queue + DI constants + channel-provider contract
// =============================================================================

import type { NotificationChannelValue } from "@sms/types";

/** BullMQ queue for async external delivery (email/SMS/push). */
export const NOTIFICATION_QUEUE = "notification-delivery";

/** Job name: deliver all PENDING channel rows for one notification. */
export const DELIVER_NOTIFICATION_JOB = "deliver-notification";

/** Injection token for the pluggable channel provider (default: logging stub). */
export const NOTIFICATION_CHANNEL_PROVIDER = Symbol("NOTIFICATION_CHANNEL_PROVIDER");

/** Enqueued per notification; the worker re-establishes tenant context from it. */
export interface DeliverNotificationJob {
  schoolId: string;
  /** Actor/recipient id used only for the tenant GUC; RLS keys on schoolId. */
  userId: string;
  notificationId: string;
}

/** One external delivery attempt handed to the provider. Carries NO more than
 *  the recipient may already see (title/body/target). */
export interface ChannelDeliveryRequest {
  channel: NotificationChannelValue;
  target: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Pluggable delivery backend. The default LoggingChannelProvider is a no-op that
 * records the attempt (no network); production binds SES/Twilio/FCM-backed
 * implementations to NOTIFICATION_CHANNEL_PROVIDER. Same optional-provider shape
 * as the integrity embeddings provider.
 */
export interface NotificationChannelProvider {
  /**
   * `providerRef` is the PROVIDER's own id for the message (Twilio's SID).
   *
   * It is what makes a credit debit reconcilable: the platform is billed by the
   * provider per message and charges the school per credit, and without an id
   * linking the two there is nothing to compare. Twilio returned it all along
   * and the adapter discarded it.
   */
  deliver(req: ChannelDeliveryRequest): Promise<{ ok: boolean; error?: string; providerRef?: string }>;
  /**
   * The messages the PROVIDER says it accepted since `since`.
   *
   * Optional: a provider with no listing API simply omits it, and the sweep
   * reports that charges could not be verified rather than pretending they
   * reconciled. This is the credit-ledger equivalent of the card rails'
   * `listSuccessfulTransactions`.
   */
  listRecentMessages?(since: Date): Promise<Array<{ providerRef: string; status?: string }>>;
}

/**
 * One page of the inbox.
 *
 * Fifty rather than the old hundred: the hundred existed because it was the
 * WHOLE list, so it had to be big enough to be useful. Now that older pages are
 * reachable, a page is a page — and every one of these rows carries a title and
 * a body, so a hundred cards is a slower render for something nobody scrolls.
 */
export const NOTIFICATION_PAGE_SIZE = 50;

/**
 * How far a count is willing to look.
 *
 * The page is bounded by the index now, but every COUNT next to it still walked
 * the whole inbox: on the platform owner's 500,000 rows, 27 ms for the plain
 * total, 42 ms for a type filter — on every page load, growing every year the
 * account exists. A screen that says "showing 50 of 1,000+" is as useful as one
 * that says "of 47,213" and costs a fixed amount to produce, so the count stops
 * looking once it has seen this many and says so.
 *
 * Paging is NOT limited by it: `hasMore` comes from fetching one row past the
 * page, so the owner can walk past the cap to anything in the inbox.
 */
export const NOTIFICATION_COUNT_CAP = 1000;
