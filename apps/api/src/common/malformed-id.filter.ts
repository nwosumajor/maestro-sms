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
// =============================================================================

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { Prisma } from "@sms/db";

/** Prisma's marker for a value it could not coerce to the column's type. */
const INCONSISTENT_COLUMN_DATA = "P2023";

export function isMalformedUuidError(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
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
    if (!isMalformedIdCandidate(host) || !isMalformedUuidError(exception)) {
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
