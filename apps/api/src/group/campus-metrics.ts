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
//   • REGISTERS: every SESSION counted as a register taken, including one a gate
//     scan opened and nobody took — and with nothing to compare it against, "12
//     registers" could not say whether 12 or 60 were due.
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
import type {
  GroupAgingDto,
  GroupComparisonDto,
  GroupFlag,
  GroupMoneyDto,
  GroupPeriodKey,
  GroupWindowDto,
} from "@sms/types";
import {
  attendanceRatePct,
  DEFAULT_GROUP_PERIOD,
  GROUP_LOW_ATTENDANCE_PCT,
  GROUP_LOW_REGISTER_COVERAGE_PCT,
  GROUP_NO_SUBSCRIPTION,
  GROUP_PERIODS,
  resolveRegion,
  schoolDateString,
  schoolMidnight,
} from "@sms/types";
import type { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { onRollOnDaySql } from "../attendance/roll";

export type PrivilegedClient = NonNullable<PrivilegedDatabaseService["client"]>;

/** A campus as the metrics need it: who, whose clock, whose week, whose terms. */
export interface Campus {
  id: string;
  timezone: string;
  /** Days of the week the school opens, 0 = Sunday — from the country, as the
   *  register reminder reads it (`isSchoolDay`). */
  schoolDays: readonly number[];
  /** The term flagged CURRENT, as days; null when none is. */
  currentTerm: { startDate: string | null; endDate: string | null } | null;
  /** Every term carrying BOTH dates — the days that were term days. */
  datedTerms: Array<{ from: string; to: string }>;
}

/** One campus's window: calendar DAYS for `@db.Date` columns, INSTANTS for timestamps. */
export interface CampusWindow extends GroupWindowDto {
  fromInstant: Date;
  toInstant: Date;
}

const DAY_MS = 86_400_000;

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

/** Inclusive length in days of `from..to`. */
function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

const dayOf = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Load what the metrics need for a set of campuses — region and terms — in ONE
 * query for the terms, never one per campus.
 */
export async function loadCampuses(
  client: PrivilegedClient,
  schools: Array<{ id: string; country: string | null; timezone: string | null }>,
): Promise<Campus[]> {
  if (schools.length === 0) return [];
  const terms = await client.term.findMany({
    where: { schoolId: { in: schools.map((s) => s.id) } },
    select: { schoolId: true, isCurrent: true, startDate: true, endDate: true },
  });
  return schools.map((s) => {
    const region = resolveRegion(s);
    const mine = terms.filter((t) => t.schoolId === s.id);
    const current = mine.find((t) => t.isCurrent);
    return {
      id: s.id,
      timezone: region.timezone,
      schoolDays: region.schoolDays,
      currentTerm: current ? { startDate: dayOf(current.startDate), endDate: dayOf(current.endDate) } : null,
      datedTerms: mine
        .filter((t) => t.startDate && t.endDate)
        .map((t) => ({ from: dayOf(t.startDate)!, to: dayOf(t.endDate)! })),
    };
  });
}

/** Instants for a run of days: midnight of the first, and either `now` (when the
 *  run ends today) or midnight after the last. */
function withInstants(w: GroupWindowDto, campus: Campus, now: Date): CampusWindow {
  const today = schoolDateString(campus.timezone, now);
  return {
    ...w,
    fromInstant: schoolMidnight(w.fromDay, campus.timezone),
    toInstant: w.toDay >= today ? now : schoolMidnight(shiftDay(w.toDay, 1), campus.timezone),
  };
}

/**
 * The window `key` covers at ONE campus, in that campus's own calendar.
 *
 * "Today" in Lagos and "today" in Toronto are different days, and a month that
 * has started in Singapore has not started in Toronto. "This term" is the
 * campus's OWN current term — terms need not align across a group — up to
 * today; a campus with no current term falls back to the last 90 days and the
 * window's `basis` says so.
 */
export function campusWindow(key: GroupPeriodKey, campus: Campus, now: Date): CampusWindow {
  const today = schoolDateString(campus.timezone, now);
  let w: GroupWindowDto;
  if (key === "term") {
    const start = campus.currentTerm?.startDate;
    if (start) {
      const end = campus.currentTerm?.endDate;
      // Up to today, and no further than the term's own last day. A term that
      // has not begun yet covers nothing but today.
      const toDay = end && end < today ? end : today;
      w = { fromDay: start <= toDay ? start : toDay, toDay, basis: "TERM" };
    } else {
      w = { fromDay: shiftDay(today, -89), toDay: today, basis: "NO_TERM_LAST_90_DAYS" };
    }
  } else {
    const fromDay =
      key === "today" ? today
      : key === "week" ? shiftDay(today, -6)
      : `${today.slice(0, 7)}-01`;
    w = { fromDay, toDay: today, basis: "PERIOD" };
  }
  return withInstants(w, campus, now);
}

/**
 * The equivalent EARLIER window: the same span, ending at the same point of the
 * previous period. Month-to-date on the 10th compares with the 1st–10th of last
 * month, never with all of it; "today so far" compares with yesterday up to the
 * same time. Never overlaps the current window.
 */
export function previousWindow(key: GroupPeriodKey, current: CampusWindow, campus: Campus): CampusWindow {
  const len = spanDays(current.fromDay, current.toDay);
  let fromDay: string;
  if (key === "month") {
    const d = new Date(`${current.fromDay}T00:00:00.000Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    fromDay = d.toISOString().slice(0, 10);
  } else {
    fromDay = shiftDay(current.fromDay, -len);
  }
  const lastAllowed = shiftDay(current.fromDay, -1);
  const naturalTo = shiftDay(fromDay, len - 1);
  const toDay = naturalTo < lastAllowed ? naturalTo : lastAllowed;
  const fromInstant = schoolMidnight(fromDay, campus.timezone);
  const toInstant = new Date(
    Math.min(
      fromInstant.getTime() + (current.toInstant.getTime() - current.fromInstant.getTime()),
      current.fromInstant.getTime(),
    ),
  );
  return { fromDay, toDay, basis: current.basis, fromInstant, toInstant };
}

/** The figures a flag is computed from. */
export interface FlagInputs {
  active: boolean;
  subscriptionStatus: string;
  students: number;
  staff: number;
  registersTaken: number;
  registersExpected: number | null;
  registersCovered: number | null;
  registerCoveragePct: number | null;
  hasCurrentTerm: boolean;
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
  // The register reminder skips a school with no current term every day, for
  // ever; the console is the one place somebody above the school can see it.
  if (x.students > 0 && !x.hasCurrentTerm) flags.push("NO_TERM");
  if (x.registersExpected != null) {
    // Measured against what was DUE, so a weekend, a holiday or a day between
    // terms is not "no registers" — it used to flag every campus on a Saturday.
    if (x.registersExpected > 0 && x.registerCoveragePct === 0) flags.push("NO_REGISTERS");
    else if (x.registerCoveragePct != null && x.registerCoveragePct < GROUP_LOW_REGISTER_COVERAGE_PCT) {
      flags.push("LOW_REGISTER_COVERAGE");
    }
  } else if (x.students > 0 && x.registersTaken === 0) {
    // No dated term, so nothing says which days were due: the old, coarser test.
    flags.push("NO_REGISTERS");
  }
  if (x.attendancePct != null && x.attendancePct < GROUP_LOW_ATTENDANCE_PCT) flags.push("LOW_ATTENDANCE");
  return flags;
}

/** The subscription status a campus reports — `NONE` when it has no row at all. */
export function subscriptionStatusOf(sub: { status: string } | null | undefined): string {
  return sub?.status ?? GROUP_NO_SUBSCRIPTION;
}

/** What a campus did over one window. */
export interface CampusActivity {
  attendancePct: number | null;
  registersTaken: number;
  registersExpected: number | null;
  registersCovered: number | null;
  registerCoveragePct: number | null;
  collected: Array<{ currency: string; collectedMinor: number }>;
}

/** A per-campus window as a VALUES list SQL can join on. Timestamps go as text
 *  without a zone, because the columns are `timestamp without time zone` holding
 *  UTC — a Date parameter would be re-read through the DB SESSION's zone. */
function windowsSql(campuses: Campus[], windows: Map<string, CampusWindow>): Prisma.Sql {
  return Prisma.join(
    campuses.map((c) => {
      const w = windows.get(c.id)!;
      const dows = c.schoolDays.length > 0 ? [...c.schoolDays] : [-1];
      return Prisma.sql`(${c.id}::uuid, ${w.fromDay}::date, ${w.toDay}::date,
        ${w.fromInstant.toISOString().slice(0, 23)}::timestamp, ${w.toInstant.toISOString().slice(0, 23)}::timestamp,
        ARRAY[${Prisma.join(dows)}]::int[])`;
    }),
  );
}

const W_COLUMNS = Prisma.raw(`w(sid, from_day, to_day, from_ts, to_ts, dows)`);

/**
 * Attendance, registers and collections for a set of campuses, each over its
 * own window — ONE grouped query per figure across all of them.
 */
export async function campusActivity(
  client: PrivilegedClient,
  campuses: Campus[],
  windows: Map<string, CampusWindow>,
): Promise<Map<string, CampusActivity>> {
  const out = new Map<string, CampusActivity>();
  if (campuses.length === 0) return out;

  const ids = campuses.map((c) => c.id);
  const values = windowsSql(campuses, windows);
  // The ENVELOPE of every campus's days, as a plain range on the partition key:
  // attendance_record is partitioned by date, and a predicate the planner can
  // read without the join is what keeps it from planning every partition.
  const ws = [...windows.values()];
  const minDay = ws.reduce((m, w) => (w.fromDay < m ? w.fromDay : m), ws[0].fromDay);
  const maxDay = ws.reduce((m, w) => (w.toDay > m ? w.toDay : m), ws[0].toDay);
  const idList = Prisma.sql`ARRAY[${Prisma.join(ids)}]::uuid[]`;
  const terms = campuses.flatMap((c) => c.datedTerms.map((t) => ({ sid: c.id, ...t })));

  const [attendance, taken, coverage, collected] = await Promise.all([
    client.$queryRaw<Array<{ schoolId: string; present: number; late: number; absent: number; excused: number }>>(Prisma.sql`
      SELECT r."schoolId",
             count(*) FILTER (WHERE r.status = 'PRESENT')::int AS present,
             count(*) FILTER (WHERE r.status = 'LATE')::int    AS late,
             count(*) FILTER (WHERE r.status = 'ABSENT')::int  AS absent,
             count(*) FILTER (WHERE r.status = 'EXCUSED')::int AS excused
        FROM attendance_record r
        JOIN (VALUES ${values}) AS ${W_COLUMNS} ON w.sid = r."schoolId"
       WHERE r."schoolId" = ANY(${idList})
         AND r.date >= ${minDay}::date AND r.date <= ${maxDay}::date
         AND r.date >= w.from_day AND r.date <= w.to_day
       GROUP BY 1
    `),
    // TAKEN registers — `takenAt` set by the register's own save. A session a
    // gate scan opened when one pupil checked in is not a register anybody took.
    client.$queryRaw<Array<{ schoolId: string; n: number }>>(Prisma.sql`
      SELECT sess."schoolId", count(*)::int AS n
        FROM attendance_session sess
        JOIN (VALUES ${values}) AS ${W_COLUMNS} ON w.sid = sess."schoolId"
       WHERE sess."schoolId" = ANY(${idList})
         AND sess.date >= ${minDay}::date AND sess.date <= ${maxDay}::date
         AND sess.date >= w.from_day AND sess.date <= w.to_day
         AND sess."takenAt" IS NOT NULL
       GROUP BY 1
    `),
    // EXPECTED registers, and how many of them were taken. A slot is a class
    // with somebody on its roll (`onRollOnDaySql`, the roll's one definition)
    // on a day that is a school day in the campus's country, inside one of its
    // terms and not a holiday — the days the register reminder chases. A campus
    // with no dated term has no slots to count and reports null, not zero.
    terms.length === 0
      ? Promise.resolve([] as Array<{ schoolId: string; expected: number; covered: number }>)
      : client.$queryRaw<Array<{ schoolId: string; expected: number; covered: number }>>(Prisma.sql`
      WITH terms(sid, t_from, t_to) AS (
        VALUES ${Prisma.join(terms.map((t) => Prisma.sql`(${t.sid}::uuid, ${t.from}::date, ${t.to}::date)`))}
      ),
      days AS (
        SELECT w.sid, g::date AS d
          FROM (VALUES ${values}) AS ${W_COLUMNS}
          CROSS JOIN LATERAL generate_series(w.from_day, w.to_day, interval '1 day') AS g
         WHERE extract(dow FROM g)::int = ANY(w.dows)
           AND EXISTS (SELECT 1 FROM terms t WHERE t.sid = w.sid AND g::date BETWEEN t.t_from AND t.t_to)
           AND NOT EXISTS (
             SELECT 1 FROM school_holiday h
              WHERE h."schoolId" = w.sid AND g::date BETWEEN h."startDate" AND h."endDate"
           )
      ),
      slots AS (
        SELECT days.sid, days.d, c.id AS class_id
          FROM days JOIN class c ON c."schoolId" = days.sid
         WHERE EXISTS (
           SELECT 1 FROM enrollment e
            WHERE e."classId" = c.id AND ${onRollOnDaySql("e", Prisma.sql`days.d`)}
         )
      )
      SELECT s.sid AS "schoolId", count(*)::int AS expected, count(sess.id)::int AS covered
        FROM slots s
        LEFT JOIN attendance_session sess
          ON sess."classId" = s.class_id AND sess.date = s.d AND sess."takenAt" IS NOT NULL
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
        JOIN (VALUES ${values}) AS ${W_COLUMNS} ON w.sid = p."schoolId"
       WHERE p."schoolId" = ANY(${idList})
         AND p.status = 'POSTED'
         AND p."paidAt" >= w.from_ts AND p."paidAt" <= w.to_ts
       GROUP BY 1, 2
    `),
  ]);

  const attOf = new Map(attendance.map((r) => [r.schoolId, r]));
  const takenOf = new Map(taken.map((r) => [r.schoolId, r.n]));
  const covOf = new Map(coverage.map((r) => [r.schoolId, r]));
  const hasTerms = new Set(terms.map((t) => t.sid));
  for (const c of campuses) {
    const a = attOf.get(c.id);
    const cov = covOf.get(c.id);
    // A campus WITH dated terms and no slots expected nothing (a weekend, a
    // holiday, between terms) — zero, not null. Null means "cannot say".
    const expected = hasTerms.has(c.id) ? (cov?.expected ?? 0) : null;
    out.set(c.id, {
      attendancePct: a ? attendanceRatePct(a) : null,
      registersTaken: takenOf.get(c.id) ?? 0,
      registersExpected: expected,
      registersCovered: expected == null ? null : (cov?.covered ?? 0),
      registerCoveragePct: expected ? Math.round(((cov?.covered ?? 0) / expected) * 100) : null,
      collected: collected
        .filter((r) => r.schoolId === c.id)
        // float8, not int: a lifetime kobo total overflows int4, and int8 comes
        // back as BigInt, which will not serialise to JSON.
        .map((r) => ({ currency: r.currency, collectedMinor: Math.round(r.total) }))
        .sort((x, y) => x.currency.localeCompare(y.currency)),
    });
  }
  return out;
}

/** What is owed at a campus NOW, per currency, with its aging. */
export interface CampusBalance {
  currency: string;
  outstandingMinor: number;
  overdueMinor: number;
  aging: GroupAgingDto;
}

/**
 * OWED NOW: each open invoice's POSITIVE balance, summed — the receivables
 * figure on the campus's own finance report — split on that report's ladder,
 * measured from the campus's OWN today.
 *
 * Only ISSUED / PARTIALLY_PAID are read: every writer derives status from net
 * paid (PAID iff net >= total), so a PAID invoice has nothing owing, and reading
 * open work only keeps this bounded by what is outstanding rather than by the
 * campus's whole billing history.
 */
export async function campusBalances(
  client: PrivilegedClient,
  campuses: Campus[],
  now: Date,
): Promise<Map<string, CampusBalance[]>> {
  const out = new Map<string, CampusBalance[]>();
  if (campuses.length === 0) return out;
  const idList = Prisma.sql`ARRAY[${Prisma.join(campuses.map((c) => c.id))}]::uuid[]`;
  const todays = Prisma.join(
    campuses.map((c) => Prisma.sql`(${c.id}::uuid, ${schoolDateString(c.timezone, now)}::date)`),
  );
  const rows = await client.$queryRaw<
    Array<{ schoolId: string; currency: string; current: number; d1_30: number; d31_60: number; d60plus: number }>
  >(Prisma.sql`
    WITH open AS (
      SELECT id, "schoolId", currency, "totalMinor", "dueDate"
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
    ),
    bal AS (
      SELECT o."schoolId", o.currency,
             GREATEST(o."totalMinor" - COALESCE(n.paid, 0), 0) AS balance,
             (t.today - o."dueDate") AS days
        FROM open o
        LEFT JOIN net n ON n."invoiceId" = o.id
        JOIN (VALUES ${todays}) AS t(sid, today) ON t.sid = o."schoolId"
    )
    SELECT "schoolId", currency,
           COALESCE(SUM(balance) FILTER (WHERE days <= 0), 0)::float8                AS current,
           COALESCE(SUM(balance) FILTER (WHERE days > 0 AND days <= 30), 0)::float8  AS d1_30,
           COALESCE(SUM(balance) FILTER (WHERE days > 30 AND days <= 60), 0)::float8 AS d31_60,
           COALESCE(SUM(balance) FILTER (WHERE days > 60), 0)::float8                AS d60plus
      FROM bal
     GROUP BY 1, 2
  `);
  for (const r of rows) {
    const aging: GroupAgingDto = {
      currentMinor: Math.round(r.current),
      d1_30Minor: Math.round(r.d1_30),
      d31_60Minor: Math.round(r.d31_60),
      d60plusMinor: Math.round(r.d60plus),
    };
    const overdue = aging.d1_30Minor + aging.d31_60Minor + aging.d60plusMinor;
    const list = out.get(r.schoolId) ?? [];
    list.push({ currency: r.currency, outstandingMinor: aging.currentMinor + overdue, overdueMinor: overdue, aging });
    out.set(r.schoolId, list);
  }
  return out;
}

/** Everything the console reports about one campus. */
export interface CampusFigures extends Omit<CampusActivity, "collected"> {
  window: GroupWindowDto;
  money: GroupMoneyDto[];
  previous: GroupComparisonDto;
}

const windowDto = (w: CampusWindow): GroupWindowDto => ({ fromDay: w.fromDay, toDay: w.toDay, basis: w.basis });

/**
 * The console's figures for a set of campuses over `key`: the window, the same
 * figures over the previous window, and what is owed now. Both pages and the
 * CSV call this and nothing else.
 */
export async function campusFigures(
  client: PrivilegedClient,
  campuses: Campus[],
  key: GroupPeriodKey,
  now: Date,
): Promise<Map<string, CampusFigures>> {
  const out = new Map<string, CampusFigures>();
  if (campuses.length === 0) return out;
  const current = new Map(campuses.map((c) => [c.id, campusWindow(key, c, now)]));
  const earlier = new Map(campuses.map((c) => [c.id, previousWindow(key, current.get(c.id)!, c)]));
  const [act, prev, balances] = await Promise.all([
    campusActivity(client, campuses, current),
    campusActivity(client, campuses, earlier),
    campusBalances(client, campuses, now),
  ]);

  for (const c of campuses) {
    const a = act.get(c.id)!;
    const p = prev.get(c.id)!;
    // Money per CURRENCY, never summed across: every currency that was either
    // collected in the window or is owed now gets a row.
    const money = new Map<string, GroupMoneyDto>();
    const slot = (currency: string): GroupMoneyDto => {
      let row = money.get(currency);
      if (!row) {
        row = {
          currency,
          collectedMinor: 0,
          outstandingMinor: 0,
          overdueMinor: 0,
          aging: { currentMinor: 0, d1_30Minor: 0, d31_60Minor: 0, d60plusMinor: 0 },
        };
        money.set(currency, row);
      }
      return row;
    };
    for (const m of a.collected) slot(m.currency).collectedMinor = m.collectedMinor;
    for (const b of balances.get(c.id) ?? []) {
      const row = slot(b.currency);
      row.outstandingMinor = b.outstandingMinor;
      row.overdueMinor = b.overdueMinor;
      row.aging = b.aging;
    }
    out.set(c.id, {
      window: windowDto(current.get(c.id)!),
      attendancePct: a.attendancePct,
      registersTaken: a.registersTaken,
      registersExpected: a.registersExpected,
      registersCovered: a.registersCovered,
      registerCoveragePct: a.registerCoveragePct,
      money: [...money.values()].sort((x, y) => x.currency.localeCompare(y.currency)),
      previous: {
        window: windowDto(earlier.get(c.id)!),
        attendancePct: p.attendancePct,
        registerCoveragePct: p.registerCoveragePct,
        collected: p.collected,
      },
    });
  }
  return out;
}
