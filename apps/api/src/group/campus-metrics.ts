// =============================================================================
// Campus metrics — the ONE definition of every figure the group console shows
// =============================================================================
// The overview, the campus page and the CSV each used to compute their own
// figures, and they disagreed:
//
//   • ATTENDANCE: the overview counted EXCUSED as attending, the campus page did
//     not — so one campus showed two rates, and both claimed to follow "the
//     report card's rule". The platform's rule is `attendanceRatePct`
//     (present + late; an excused absence is an absence), and the overview's
//     unit test asserted the wrong one.
//   • PERIOD: the campus page was handed no period by the web at all, so a
//     director looking at 90 days clicked through to "this month". Its money
//     ignored the period even when one was passed.
//   • MONEY: collected counted kind PAYMENT only (a refund never came off), and
//     outstanding netted a whole campus at once (one overpaid invoice hid
//     another family's debt) — neither the campus's own finance report's figure.
//   • DAY: windows were cut at the SERVER's midnight, not each campus's.
//
// Everything here is computed for a SET of campuses in one grouped query per
// figure — never a query per school — so the campus page is simply the
// overview's question asked about one campus, and agrees with it by
// construction.
//
// Runs on the PRIVILEGED client (no RLS), so EVERY query filters `schoolId`
// explicitly. Aggregates only: nothing here returns a pupil, an invoice or a
// payment row.
// =============================================================================

import { Prisma } from "@sms/db";
import type { GroupFlag, GroupMoneyDto, GroupPeriodKey } from "@sms/types";
import {
  attendanceRatePct,
  DEFAULT_GROUP_PERIOD,
  GROUP_LOW_ATTENDANCE_PCT,
  GROUP_NO_SUBSCRIPTION,
  GROUP_PERIODS,
  schoolDateString,
  schoolMidnight,
} from "@sms/types";
import type { PrivilegedDatabaseService } from "../common/privileged-database.service";

export type PrivilegedClient = NonNullable<PrivilegedDatabaseService["client"]>;

/** A campus as the metrics need it: who, and whose clock. */
export interface Campus {
  id: string;
  timezone: string;
}

/** One campus's window: calendar DAYS for `@db.Date` columns, INSTANTS for timestamps. */
export interface CampusWindow {
  fromDay: string;
  toDay: string;
  fromInstant: Date;
  toInstant: Date;
}

/** An unknown key falls back to the default rather than erroring — it arrives from a URL. */
export function periodKeyOf(key: string | undefined): GroupPeriodKey {
  return GROUP_PERIODS.some((p) => p.key === key) ? (key as GroupPeriodKey) : DEFAULT_GROUP_PERIOD;
}

export function periodLabelOf(key: GroupPeriodKey): string {
  return GROUP_PERIODS.find((p) => p.key === key)!.label;
}

/** `YYYY-MM-DD` shifted by whole days. Calendar arithmetic, never through a zone. */
function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The window `key` covers at ONE campus, in that campus's own calendar.
 *
 * "Today" in Lagos and "today" in Toronto are different days, and a month that
 * has started in Singapore has not started in Toronto. Cutting at the server's
 * midnight put the start of the month an hour late in Lagos.
 */
export function campusWindow(key: GroupPeriodKey, timezone: string, now: Date): CampusWindow {
  const today = schoolDateString(timezone, now);
  const fromDay =
    key === "today" ? today
    : key === "week" ? shiftDay(today, -6)
    : key === "term" ? shiftDay(today, -89)
    : `${today.slice(0, 7)}-01`;
  return { fromDay, toDay: today, fromInstant: schoolMidnight(fromDay, timezone), toInstant: now };
}

/** The figures a flag is computed from. */
export interface FlagInputs {
  active: boolean;
  subscriptionStatus: string;
  students: number;
  staff: number;
  registersTaken: number;
  attendancePct: number | null;
}

/** Conditions a director should act on. ONE function, used by both pages. */
export function flagsFor(x: FlagInputs): GroupFlag[] {
  const flags: GroupFlag[] = [];
  if (!x.active) flags.push("DISABLED");
  // A campus with NO subscription row is resolved to the STANDARD floor by the
  // entitlement gate; it is not paid up, so it is flagged like any other lapse.
  if (x.subscriptionStatus !== "ACTIVE") flags.push("BILLING");
  if (x.students > 0 && x.staff === 0) flags.push("NO_STAFF");
  // Only meaningful where there are pupils to register.
  if (x.students > 0 && x.registersTaken === 0) flags.push("NO_REGISTERS");
  else if (x.attendancePct != null && x.attendancePct < GROUP_LOW_ATTENDANCE_PCT) flags.push("LOW_ATTENDANCE");
  return flags;
}

/** The subscription status a campus reports — `NONE` when it has no row at all. */
export function subscriptionStatusOf(sub: { status: string } | null | undefined): string {
  return sub?.status ?? GROUP_NO_SUBSCRIPTION;
}

/** Everything the console reports about one campus over one window. */
export interface CampusFigures {
  attendancePct: number | null;
  registersTaken: number;
  money: GroupMoneyDto[];
}

/** A per-campus window as a VALUES list SQL can join on. Timestamps go as text
 *  without a zone, because the columns are `timestamp without time zone` holding
 *  UTC — a Date parameter would be re-read through the DB SESSION's zone. */
function windowsSql(campuses: Campus[], windows: Map<string, CampusWindow>): Prisma.Sql {
  return Prisma.join(
    campuses.map((c) => {
      const w = windows.get(c.id)!;
      return Prisma.sql`(${c.id}::uuid, ${w.fromDay}::date, ${w.toDay}::date,
        ${w.fromInstant.toISOString().slice(0, 23)}::timestamp, ${w.toInstant.toISOString().slice(0, 23)}::timestamp)`;
    }),
  );
}

/**
 * Attendance, registers and money for a set of campuses — ONE grouped query
 * per figure across all of them.
 */
export async function campusFigures(
  client: PrivilegedClient,
  campuses: Campus[],
  key: GroupPeriodKey,
  now: Date,
): Promise<Map<string, CampusFigures>> {
  const out = new Map<string, CampusFigures>();
  if (campuses.length === 0) return out;

  const windows = new Map(campuses.map((c) => [c.id, campusWindow(key, c.timezone, now)]));
  const ids = campuses.map((c) => c.id);
  const values = windowsSql(campuses, windows);
  // The ENVELOPE of every campus's days, as a plain range on the partition key:
  // attendance_record is partitioned by date, and a predicate the planner can
  // read without the join is what keeps it from planning every partition.
  const days = [...windows.values()];
  const minDay = days.reduce((m, w) => (w.fromDay < m ? w.fromDay : m), days[0].fromDay);
  const maxDay = days.reduce((m, w) => (w.toDay > m ? w.toDay : m), days[0].toDay);
  const idList = Prisma.sql`ARRAY[${Prisma.join(ids)}]::uuid[]`;

  const [attendance, registers, collected, outstanding] = await Promise.all([
    client.$queryRaw<Array<{ schoolId: string; present: number; late: number; absent: number; excused: number }>>(Prisma.sql`
      SELECT r."schoolId",
             count(*) FILTER (WHERE r.status = 'PRESENT')::int AS present,
             count(*) FILTER (WHERE r.status = 'LATE')::int    AS late,
             count(*) FILTER (WHERE r.status = 'ABSENT')::int  AS absent,
             count(*) FILTER (WHERE r.status = 'EXCUSED')::int AS excused
        FROM attendance_record r
        JOIN (VALUES ${values}) AS w(sid, from_day, to_day, from_ts, to_ts) ON w.sid = r."schoolId"
       WHERE r."schoolId" = ANY(${idList})
         AND r.date >= ${minDay}::date AND r.date <= ${maxDay}::date
         AND r.date >= w.from_day AND r.date <= w.to_day
       GROUP BY 1
    `),
    // SESSIONS taken, not records: a campus that has stopped taking registers
    // must read as such, whatever its record count over a longer window.
    client.$queryRaw<Array<{ schoolId: string; n: number }>>(Prisma.sql`
      SELECT sess."schoolId", count(*)::int AS n
        FROM attendance_session sess
        JOIN (VALUES ${values}) AS w(sid, from_day, to_day, from_ts, to_ts) ON w.sid = sess."schoolId"
       WHERE sess."schoolId" = ANY(${idList})
         AND sess.date >= ${minDay}::date AND sess.date <= ${maxDay}::date
         AND sess.date >= w.from_day AND sess.date <= w.to_day
       GROUP BY 1
    `),
    // NET settled in the window. A payment carries no currency of its own — it
    // inherits its INVOICE's — so the currency comes through the join. A REFUND
    // subtracts, exactly as every invoice balance treats it (`netPaidOf`).
    client.$queryRaw<Array<{ schoolId: string; currency: string; total: number }>>(Prisma.sql`
      SELECT p."schoolId", i.currency,
             SUM(CASE WHEN p.kind = 'REFUND' THEN -p."amountMinor"::numeric ELSE p."amountMinor"::numeric END)::float8 AS total
        FROM payment p
        JOIN invoice i ON i.id = p."invoiceId"
        JOIN (VALUES ${values}) AS w(sid, from_day, to_day, from_ts, to_ts) ON w.sid = p."schoolId"
       WHERE p."schoolId" = ANY(${idList})
         AND p.status = 'POSTED'
         AND p."paidAt" >= w.from_ts AND p."paidAt" <= w.to_ts
       GROUP BY 1, 2
    `),
    // OWED NOW: each open invoice's POSITIVE balance, summed — the receivables
    // figure on the campus's own finance report. Only ISSUED / PARTIALLY_PAID
    // are read: every writer derives status from net paid (PAID iff
    // net >= total), so a PAID invoice has nothing owing, and reading open work
    // only keeps this bounded by what is outstanding rather than by the
    // campus's whole billing history.
    client.$queryRaw<Array<{ schoolId: string; currency: string; total: number }>>(Prisma.sql`
      WITH open AS (
        SELECT id, "schoolId", currency, "totalMinor"
          FROM invoice
         WHERE "schoolId" = ANY(${idList}) AND status IN ('ISSUED', 'PARTIALLY_PAID')
      ),
      net AS (
        SELECT p."invoiceId",
               SUM(CASE WHEN p.kind = 'REFUND' THEN -p."amountMinor"::numeric ELSE p."amountMinor"::numeric END) AS paid
          FROM payment p
         WHERE p."schoolId" = ANY(${idList}) AND p.status = 'POSTED'
           AND p."invoiceId" IN (SELECT id FROM open)
         GROUP BY 1
      )
      SELECT o."schoolId", o.currency,
             SUM(GREATEST(o."totalMinor" - COALESCE(n.paid, 0), 0))::float8 AS total
        FROM open o LEFT JOIN net n ON n."invoiceId" = o.id
       GROUP BY 1, 2
    `),
  ]);

  const attOf = new Map(attendance.map((r) => [r.schoolId, r]));
  const regOf = new Map(registers.map((r) => [r.schoolId, r.n]));
  // Money per campus per CURRENCY. Never summed across currencies.
  const money = new Map<string, Map<string, GroupMoneyDto>>();
  const slot = (schoolId: string, currency: string): GroupMoneyDto => {
    let per = money.get(schoolId);
    if (!per) money.set(schoolId, (per = new Map()));
    let row = per.get(currency);
    if (!row) per.set(currency, (row = { currency, collectedMinor: 0, outstandingMinor: 0 }));
    return row;
  };
  // float8, not int: a lifetime kobo total overflows int4, and int8 comes back
  // as BigInt, which will not serialise to JSON.
  for (const r of collected) slot(r.schoolId, r.currency).collectedMinor += Math.round(r.total);
  for (const r of outstanding) slot(r.schoolId, r.currency).outstandingMinor += Math.round(r.total);

  for (const id of ids) {
    const a = attOf.get(id);
    out.set(id, {
      attendancePct: a ? attendanceRatePct(a) : null,
      registersTaken: regOf.get(id) ?? 0,
      money: [...(money.get(id)?.values() ?? [])].sort((x, y) => x.currency.localeCompare(y.currency)),
    });
  }
  return out;
}
