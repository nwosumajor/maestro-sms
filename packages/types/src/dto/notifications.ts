// Notifications response DTOs.

export interface NotificationItemDto {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationInboxDto {
  items: NotificationItemDto[];
  unread: number;
}

// =============================================================================
// Deliveries that did not arrive
// =============================================================================
// `notification_delivery` records every external attempt and, until now, was
// written by one place and read by exactly one: the job that performs it. So a
// FAILED row — a parent's number the provider rejected, a bounced receipt, a
// message skipped because the school had run out of credits — was recorded and
// then seen by nobody. The school believed the family had been told.
//
// This is the read that closes that. Staff-gated on `notification.send`: the
// people who may send are the people who need to know what did not arrive.
// It names the RECIPIENT and the CHANNEL but never the resolved target — a
// failure report is not a route to a phone book, and the address is on the SIS
// record for anyone entitled to it.
export interface FailedDeliveryDto {
  id: string;
  notificationId: string;
  recipientName: string;
  /** What the message was about, so a reader can judge how much the miss matters. */
  title: string;
  type: string;
  channel: string;
  /** The provider's reason, or ours. */
  error: string | null;
  attempts: number;
  createdAt: Date;
}

export interface DeliveryProblemsDto {
  /** Most recent first, capped. */
  failures: FailedDeliveryDto[];
  /** Failures in the window, which may exceed the number listed. */
  total: number;
  /** Deliveries still waiting — normally seconds old; a growing number is a stuck worker. */
  pending: number;
  /** How far back this looks. */
  windowDays: number;
}
