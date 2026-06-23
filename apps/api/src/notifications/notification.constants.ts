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
  deliver(req: ChannelDeliveryRequest): Promise<{ ok: boolean; error?: string }>;
}
