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
  /**
   * How many match the filter — NOT how many were returned.
   *
   * The inbox returned the most-recent hundred and said nothing about the rest,
   * which is right for a queue and wrong for a record. The platform owner's
   * inbox is a record: it is where "did we alert anyone about that dispute",
   * "when did that school lapse" and "what did the dunning sweep say in March"
   * are answered, and there was no filter, no page and no way to reach anything
   * older than the last hundred arrivals.
   */
  total: number;
  /** The count stopped looking at the cap — display it as "1,000+", not "1,000". */
  totalIsCapped: boolean;
  unreadIsCapped: boolean;
  page: number;
  pageSize: number;
  /**
   * There is at least one more page.
   *
   * From fetching one row past the page, NOT from the total — so paging is never
   * limited by the count's cap, and the owner can walk back to anything.
   */
  hasMore: boolean;
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
