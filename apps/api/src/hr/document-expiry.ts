// =============================================================================
// A certificate that has EXPIRED says so — and says it once
// =============================================================================
// The staff-document sweep notified HR when a document came within 30 days of
// expiry, stamped `reminderSentAt`, and never looked at that row again. So the
// only notice a school ever got about a teaching licence or a safeguarding
// check was one sent BEFORE it lapsed. On the day it actually expired, and
// every day after, there was silence.
//
// Measured live on the running stack, one sweep:
//
//   PROBE licence     expires 2026-08-23   "expires on 2026-08-23"   (5 days AGO)
//   PROBE DBS check   expires 2026-09-07   "expires on 2026-09-07"
//   second run                             {"reminded":0}
//
// Two defects in that output. The wording is in the FUTURE TENSE about a
// licence that had already lapsed — the sweep's window is `<= now + 30d`, which
// admits an already-expired document, and the message never asked. And the DBS
// check will lapse in ten days with nothing left to mention it, because its row
// is now stamped.
//
// This platform runs seventeen scheduled sweeps and chases an overdue library
// book, a boarder signed out too long and an invoice past due. A lapsed
// safeguarding certificate — the one with a child-protection consequence — was
// the thing it stopped chasing at the moment it started to matter.
//
// TWO NOTICES AT MOST, and the stage is what bounds it. Exactly the shape
// `deadlineNoticeStage` already uses on the breach register one module over: a
// notice goes only when the stage CHANGES, because a notice per night is one
// people learn to ignore — including on the document where it mattered.
//
// // A DOCUMENT ALREADY EXPIRED WHEN IT IS FIRST SEEN GOES STRAIGHT TO
// `EXPIRED` and never receives an "expiring soon". A warning about something
// that has already happened is not a warning, and it was how the wrong tense
// reached HR in the first place.
//
// // THE COMPARISON IS DAY AGAINST DAY. `expiresAt` is a `@db.Date` — a DAY,
// not an instant — so it is compared with the SCHOOL's calendar day, never the
// server's UTC one. A certificate is valid THROUGH the day it names, so
// `expired` is `expiresAt < today`, not `<=`.
// =============================================================================

import { Prisma } from "@sms/db";

/** How far ahead a document is announced as expiring. */
export const DOCUMENT_REMINDER_WINDOW_DAYS = 30;

export type DocumentExpiryStage = "EXPIRING" | "EXPIRED";

/** The terminal stage — a row here can never need another notice. */
export const TERMINAL_EXPIRY_STAGE: DocumentExpiryStage = "EXPIRED";

const DAY_MS = 86_400_000;

/**
 * Which notice this document is owed AS AT the school's day, or null if none.
 *
 * `today` and `expiresAt` are both UTC-midnight days (`schoolToday` produces
 * the same form every `@db.Date` stores), so this is an exact day comparison.
 */
export function expiryStage(
  expiresAt: Date | null | undefined,
  today: Date,
): DocumentExpiryStage | null {
  if (!expiresAt) return null;
  const on = expiresAt.getTime();
  const now = today.getTime();
  // Valid THROUGH the day it names: expired only once that day has passed.
  if (on < now) return "EXPIRED";
  if (on <= now + DOCUMENT_REMINDER_WINDOW_DAYS * DAY_MS) return "EXPIRING";
  return null;
}

/**
 * The rows that can still change stage.
 *
 * Bounded deliberately: without the stage filter every document a school has
 * ever let expire is re-read every night for ever, to be skipped — the
 * O(the school's lifetime) shape this repo keeps closing. A row already at the
 * terminal stage is done.
 *
 * The date ceiling is generous by two days ON PURPOSE. This runs once for the
 * whole fleet before any school's own day is known, and a school can be most of
 * a day either side of UTC; a tight ceiling would drop a document from the
 * candidate set before the school it belongs to had been asked.
 */
export function expiryCandidateWhere(now: Date): Prisma.StaffDocumentWhereInput {
  return {
    expiresAt: { not: null, lte: new Date(now.getTime() + (DOCUMENT_REMINDER_WINDOW_DAYS + 2) * DAY_MS) },
    OR: [{ expiryNoticeStage: null }, { expiryNoticeStage: { not: TERMINAL_EXPIRY_STAGE } }],
  };
}

/**
 * What HR is told about a DOCUMENT. The tense follows the stage, which is the
 * point.
 */
export function documentExpiryNotice(
  d: { who: string; kind: string; name: string; expiresAt: Date | null },
  stage: DocumentExpiryStage,
): { title: string; body: string } {
  const on = d.expiresAt ? d.expiresAt.toISOString().slice(0, 10) : "an unrecorded date";
  return stage === "EXPIRED"
    ? {
        title: "Staff document has EXPIRED",
        body:
          `${d.who}'s ${d.kind} (“${d.name}”) expired on ${on} and is no longer valid. ` +
          `Record the renewal, or check whether they may continue in duties that require it.`,
      }
    : {
        title: "Staff document expiring soon",
        body: `${d.who}'s ${d.kind} (“${d.name}”) expires on ${on}.`,
      };
}

/**
 * What HR is told about a CONTRACT.
 *
 * The same defect lived here, in the same file, one method down: a contract was
 * announced once before it ended, `contractReminderSentAt` was stamped, and the
 * day it actually ended produced silence — while the employee stayed ACTIVE.
 * Somebody working past the end of their contract is a fact a school has to
 * act on, and it was the moment the product stopped mentioning it.
 */
export function contractEndNotice(
  d: { who: string; endDate: Date | null },
  stage: DocumentExpiryStage,
): { title: string; body: string } {
  const on = d.endDate ? d.endDate.toISOString().slice(0, 10) : "an unrecorded date";
  return stage === "EXPIRED"
    ? {
        title: "Contract has ENDED",
        body:
          `${d.who}'s contract ended on ${on} and they are still recorded as active staff. ` +
          `Renew it, or start offboarding.`,
      }
    : {
        title: "Contract ending soon",
        body: `${d.who}'s contract ends on ${on} — renew or start offboarding.`,
      };
}

/** The rows whose contract stage can still change. Bounded for the same reason. */
export function contractCandidateWhere(now: Date): Prisma.EmployeeWhereInput {
  return {
    status: "ACTIVE",
    endDate: { not: null, lte: new Date(now.getTime() + (DOCUMENT_REMINDER_WINDOW_DAYS + 2) * DAY_MS) },
    OR: [{ contractNoticeStage: null }, { contractNoticeStage: { not: TERMINAL_EXPIRY_STAGE } }],
  };
}
