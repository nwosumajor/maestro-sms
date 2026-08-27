// =============================================================================
// MalformedIdFilter — an unparseable id is "not found", not a crash
// =============================================================================
// `GET /timetable/periods/undefined` returned **500**. Route params carry no
// UUID validation, so the string reaches Prisma, Postgres cannot parse it, and
// an ordinary client mistake surfaced as an internal error: alarming to the
// user, noisy in Sentry, and indistinguishable from a real fault on the
// dashboard. Every `:id` route in the API had this, not just timetable.
//
// A filter rather than a pipe, deliberately. Adding `ParseUUIDPipe` to several
// hundred params would be a large, error-prone diff, and would be WRONG on the
// params that are legitimately not UUIDs — `/members/scan/:code`, slugs,
// gateway references. This costs nothing per request: it runs only on an error
// that is currently a 500.
//
// 404 rather than 400, because it is the answer the caller already gets for a
// well-formed id that does not exist. Two different statuses for "no such
// thing" would be a distinction without a difference, and 404 is what the rest
// of this codebase returns rather than disclosing existence.
//
// SCOPE: only a UUID PARSE failure. P2023 is "inconsistent column data"
// generally — a corrupt enum or a bad column value raises it too, and turning
// THAT into a quiet 404 would hide real data corruption behind a shrug. Those
// still throw.
//
// -----------------------------------------------------------------------------
// It now also translates P2002, a UNIQUE CONSTRAINT violation, into a 409.
//
// The same argument, on a bigger surface. This filter caught malformed UUIDs
// and let everything else fall through to a 500 — so ANY duplicate a user could
// create was an "Internal server error". Confirmed live, and not as a race:
//
//     POST /hr/leave/types {"name":"Study Leave Probe"}   201
//     POST /hr/leave/types {"name":"Study Leave Probe"}   500
//
// An HR manager adding a leave type that already exists is told the server
// broke. A sweep found EIGHT creates on uniquely-constrained models with no
// duplicate check and no catch — leave types, an invoice REFERENCE the caller
// supplies, a second current academic session, a biometric device, an
// invigilator assigned twice, an agent code. Fixing eight call sites would
// leave the ninth, so the translation lives here.
//
// It does not replace a per-site check. Where one exists — the library's "A
// book with that barcode already exists" — it still runs first and still gives
// the better message. This is the floor, not the ceiling.
//
// // GOTCHA: Prisma does NOT populate `meta.target` here. The raw error reads
// "Unique constraint failed on the (not available)", so there is no field name
// to quote — the same absent-meta trap a previous translator in this codebase
// fell into. What the message DOES carry is the model, as
// `Invalid \`prisma.leaveType.create()\` invocation`, so that is what is
// parsed and humanised. When even that is missing the wording stays honest and
// vague rather than inventing a field.
// =============================================================================

import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { Prisma } from "@sms/db";

/** Prisma's marker for a value it could not coerce to the column's type. */
const INCONSISTENT_COLUMN_DATA = "P2023";
/** Prisma's marker for a unique constraint violation. */
const UNIQUE_VIOLATION = "P2002";
/** Prisma's marker for a RAW query that the database rejected. */
const RAW_QUERY_FAILED = "P2010";

/**
 * "leaveType" -> "leave type". Best effort: the model is the only thing the
 * error reliably carries, and a caller reading "A leave type with those details
 * already exists" can act, where "Internal server error" leaves them stuck.
 */
export function duplicateMessage(e: Prisma.PrismaClientKnownRequestError): string {
  const model = /prisma\.(\w+)\.\w+\(\)/.exec(e.message)?.[1];
  if (!model) return "That already exists.";
  const words = model.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return `A ${words} with those details already exists.`;
}

export function isMalformedUuidError(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  // RAW SQL FAILS DIFFERENTLY, and the gap was live.
  //
  // This filter caught the shape the Prisma CLIENT produces (P2023, "Error
  // creating UUID"). A raw statement that casts the id itself — `${id}::uuid` —
  // never reaches that code path: Postgres rejects the cast and Prisma reports
  // P2010 wrapping SQLSTATE 22P02.
  //
  // It matters because the routes that touch an id with RAW SQL FIRST are the
  // ones that take a ROW LOCK before reading, which is the careful thing to do.
  // `POST /invoices/:id/payments` locks the invoice `FOR UPDATE` before its
  // findFirst, deliberately, so two recorders cannot both pass the overpayment
  // check — and that made it the one write in the API still answering 500 to a
  // malformed id while `issue` and `cancel` on the same resource answered 404.
  //
  // MATCHED ON THE TYPE NAME, not on 22P02, which is "invalid text
  // representation" generally and fires for a bad integer, enum or json too.
  // Turning those into a quiet 404 would hide real faults — the same line this
  // filter already draws around a general P2023.
  if (e.code === RAW_QUERY_FAILED) {
    return /invalid input syntax for type uuid/i.test(String(e.message));
  }
  if (e.code !== INCONSISTENT_COLUMN_DATA) return false;
  // Verified against the running database, not assumed: meta.message reads
  // "Error creating UUID, invalid character: ...". The last error translator in
  // this codebase keyed off a `meta` field Prisma never populates and silently
  // never fired, so this one is matched against real output.
  const detail = String((e.meta as { message?: string } | undefined)?.message ?? e.message);
  return detail.includes("Error creating UUID");
}

@Catch(Prisma.PrismaClientKnownRequestError)
export class MalformedIdFilter extends BaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("MalformedId");

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    if (!isMalformedIdCandidate(host)) {
      super.catch(exception, host);
      return;
    }
    if (exception.code === UNIQUE_VIOLATION) {
      const req = host.switchToHttp().getRequest<{ method?: string; url?: string }>();
      // Not debug: a duplicate reaching here means no call site checked for it,
      // which is worth seeing when deciding where a per-site message would read
      // better than the generic one.
      this.logger.warn(`duplicate on ${req?.method} ${req?.url} -> 409`);
      super.catch(new ConflictException(duplicateMessage(exception)), host);
      return;
    }
    if (!isMalformedUuidError(exception)) {
      // Anything else keeps its existing behaviour — including a genuine
      // P2023 from corrupt data, which must stay a loud 500.
      super.catch(exception, host);
      return;
    }
    const req = host.switchToHttp().getRequest<{ method?: string; url?: string }>();
    this.logger.debug(`malformed id on ${req?.method} ${req?.url} -> 404`);
    super.catch(new NotFoundException("Not found"), host);
  }
}

/** Only HTTP requests — a malformed id in a BullMQ job is a real bug, and
 *  quietly 404ing it would strand the job with no signal. */
function isMalformedIdCandidate(host: ArgumentsHost): boolean {
  return host.getType() === "http";
}

/** Re-exported so a service can reuse the same test without the filter. */
export { HttpException };
