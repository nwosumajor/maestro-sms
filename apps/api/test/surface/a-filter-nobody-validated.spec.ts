// =============================================================================
// A filter nobody validated answers a question nobody asked
// =============================================================================
// A `?status=` a route does not recognise fails in one of two ways, and both
// are worse than an error:
//
//   passed straight into the query  -> matches nothing -> "no boarders are
//                                      signed out", "no books are on loan"
//   quietly dropped to undefined    -> matches everything -> the WHOLE ledger,
//                                      under the label the user picked
//
// `/fees/disputes` was fixed for exactly this and the reasoning was written
// down: "an invalid `status` is a 400 that renders the LOAD-FAILURE card —
// never 'No disputes recorded', which is a statement about money a finance
// officer acts on". Three siblings kept the old behaviour, one of them three
// hundred lines below that fix in the same controller:
//
//   GET /invoices        dropped it -> 14 of 14 rows, "filtered"
//   GET /hostels/exeats  used it    -> 1 pupil away and overdue became 0
//   GET /library/loans   used it    -> 26 loans became 0
//
// Measured live, before and after, on each.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiRoutes } from "../support/api-routes";

const API_SRC = join(__dirname, "..", "..", "src");

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * A route whose `status` is deliberately unvalidated, with the reason.
 *
 * Empty. Every list that narrows on a status set narrows on a KNOWN set, so
 * there is nothing an unrecognised value can legitimately mean.
 */
const ALLOWED: Record<string, string> = {
  "GET /cbt/exams/all":
    "A DELIBERATE decision, in the handler's own words: \"this is a filter, not a " +
    "command, and an empty list is the honest answer\". Left as the author set it — " +
    "the exam list is staff-only admin, not a statement about a child's whereabouts " +
    "or a school's money, which is where the same behaviour does real harm.",
  "GET /classes/:classId/content":
    "`status` here can only ever NARROW within what the caller may already see — the " +
    "service ignores it entirely for students and parents, so an unrecognised value " +
    "cannot widen access and cannot make a safety or money claim. It narrows a list " +
    "of lesson material.",
};

/** Handlers that take a `status` query parameter at all. */
function statusFilters(): Array<{ key: string; file: string; body: string }> {
  return apiRoutes(API_SRC)
    .filter((r) => r.method === "GET")
    .filter((r) => /@Query\(\s*["']status["']\s*\)/.test(r.body))
    .map((r) => ({ key: r.key, file: r.file.split("/src/")[1] ?? r.file, body: r.body }));
}

describe("every list that pages", () => {
  // `page ? Number(page) : 1` turns a typo into NaN, and NaN reaches Prisma as
  // `skip: NaN` — a PrismaClientValidationError, a 500, and (through the
  // observability spine) a Sentry event. Measured live: `?page=abc` on
  // `/students/exited`, `/operator/tenants` and `/operator/payments` each
  // answered 500. `?page=1e999` did the same by way of Infinity.
  //
  // A 400 is also what this API already does wherever it uses Zod — /workflows,
  // /admissions, /assessments and /fees/disputes all answer
  // `z.coerce.number().int().min(1)` with one. The hand-rolled sites were the
  // outliers, not the rule.
  // COMMENTS STRIPPED. A gate that reads prose fails on the explanation of its
  // own rule — the trap `money-is-not-divided-by-a-hundred` already strips for,
  // and which caught this file twice while it was being written: a comment
  // saying "`Number(page)` on a typo is NaN" was read as a `Number(page)` call.
  const paging = apiRoutes(API_SRC)
    .filter((r) => r.method === "GET")
    .filter((r) => /@Query\(\s*["'](page|pageSize)["']\s*\)/.test(r.body))
    .map((r) => ({ key: r.key, file: r.file.split("/src/")[1] ?? r.file, body: stripComments(r.body) }));

  it("found the paged lists at all", () => {
    expect(paging.length).toBeGreaterThanOrEqual(4);
  });

  it("never hands a raw Number() straight to the query", () => {
    // WHOLE CONTROLLER FILES, not just route bodies.
    //
    // The first version scanned each handler's own body and missed
    // `/operator/payments` entirely: its parse lives in a private
    // `paymentFilters(q)` helper further down the file, so the route body had
    // nothing to flag. It kept 500-ing on `?page=abc` while the gate reported
    // the class closed — a gate passing by looking in the wrong place, which is
    // the failure mode `a-gate-must-not-pass-by-finding-nothing` names.
    //
    // // GOTCHA: `pageNumber(page)` CONTAINS the substring `Number(page)`, so
    // the obvious pattern flagged every site the fix had just corrected. The
    // lookbehind is what makes it a call to `Number` rather than the tail of
    // another identifier.
    const RAW = /(?<![A-Za-z_$])Number\(\s*[A-Za-z_$][\w.$]*\.?(page|pageSize)\s*\)/i;
    const files = [...new Set(apiRoutes(API_SRC).map((r) => r.file))];
    expect(files.length).toBeGreaterThan(30);
    const raw = files
      .filter((f) => RAW.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => f.split("/src/")[1] ?? f);
    expect(raw).toEqual([]);
  });

  it("parses through the shared helper, or through Zod's coercion", () => {
    const unparsed = paging
      .filter((r) => !/pageNumber\(|ZodValidationPipe|z\.coerce/.test(r.body))
      .map((r) => `${r.key}  (${r.file})`);
    expect(unparsed).toEqual([]);
  });
});

describe("every list that narrows on a status", () => {
  const filters = statusFilters();

  it("found the filters at all — the scan has not silently broken", () => {
    // A walk that finds nothing produces no offenders and passes covering
    // nothing. Invoices, exeats, loans and incidents at least.
    expect(filters.length).toBeGreaterThanOrEqual(3);
  });

  it("REFUSES a value it does not recognise, rather than guessing", () => {
    // THROUGH THE SHARED NARROWER, not a hand-rolled check per route. This repo
    // has already recorded what the alternative costs — "the CSV formula guard
    // existed 9x under 4 names" — and a control written nine times is a control
    // that will be right eight times. `narrowStatus` is the one place the
    // decision lives, so this asks only that each filter goes through it.
    const silent = filters
      .filter((f) => !(f.key in ALLOWED))
      .filter((f) => !/narrowStatus\(/.test(f.body))
      .map((f) => `${f.key}  (${f.file})`);
    expect(silent).toEqual([]);
  });

  it("gives every exemption a reason, and none that is now unused", () => {
    const live = new Set(filters.map((f) => f.key));
    for (const [key, why] of Object.entries(ALLOWED)) {
      expect([key, why.length > 60]).toEqual([key, true]);
      expect([key, live.has(key)]).toEqual([key, true]);
    }
  });

  it("names the allowed values in the refusal, so the caller can correct it", () => {
    // "status must be one of ISSUED, RETURNED" is actionable; "invalid status"
    // sends somebody to read the source.
    const helper = readFileSync(join(API_SRC, "common/status-filter.ts"), "utf8");
    expect(helper).toMatch(/must be one of \$\{allowed\.join/);
    // And an ABSENT value is not an error: a cleared dropdown submits an empty
    // string, and refusing that would break "show me everything".
    expect(helper).toMatch(/if \(!v\) return undefined/);
  });
});

// =============================================================================
// The same question, asked of dates and of numbers
// =============================================================================
// `status` was the first shape of this. `from`/`to`/`limit`/`days`/`year` are
// the same input class and were failing in the same two directions at once:
//
//   new Date("abc")              -> Invalid Date -> Prisma -> HTTP 500
//   Number("abc") ?? 50          -> NaN (?? never fires) -> take: NaN -> 500
//   a regex that drops a no-match -> the ALL-TIME total under a month's caption
//
// Measured live before the fix: `/analytics/overview`, `/attendance/by-class`,
// `/exams`, `/library/report`, `/security/audit` (twice) and
// `/notifications/deliveries/problems` each answered 500 to a typo;
// `/hr/leave/calendar` did too and the probe could not see it, because the
// account it ran as lacks the permission. Meanwhile `/operator/payments`
// answered 200 with NGN 25,700,236.64 of all-time revenue for an August window.
// =============================================================================
describe("a date or a number a caller typed", () => {
  const DATED = /@Query\("(from|to|date|days|year|month|limit)"\)/;
  const dated = apiRoutes(API_SRC).filter((r) => DATED.test(r.body));

  it("found the dated and counted reads at all", () => {
    expect(dated.length).toBeGreaterThan(20);
  });

  it("never builds a Date straight out of a query value", () => {
    // Whole FILES, for the reason the paging check gives: the parse routinely
    // lives one call down, in the service or in a private helper.
    // // GOTCHA: `new Date(from.getTime() + N)` is a legitimate arithmetic use
    // of an ALREADY-PARSED Date. Matching it flags the correct code and hides
    // the offender underneath, which is how a gate teaches people to exempt it.
    const RAW = /new Date\(\s*`?\$?\{?(opts\.|filter\.|f\.|q\.|range\?\.|input\.)?(from|to|fromISO|toISO)\b(?!\.)/;
    const files = [...new Set(dated.map((r) => r.file))];
    const offenders: string[] = [];
    for (const f of files) {
      const here = [f, ...serviceFilesFor(f)];
      for (const src of here) {
        let text: string;
        try {
          text = stripComments(readFileSync(src, "utf8"));
        } catch {
          continue;
        }
        if (RAW.test(text)) offenders.push(src.split("/src/")[1] ?? src);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("never hands a raw Number() straight to a limit, a day count or a year", () => {
    const RAW = /(?<![A-Za-z_$])Number\(\s*[A-Za-z_$][\w.$]*\.?(limit|days|year|month)\s*\)/i;
    const files = [...new Set(dated.map((r) => r.file))];
    expect(files.length).toBeGreaterThan(10);
    const raw = files
      .filter((f) => RAW.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => f.split("/src/")[1] ?? f);
    expect(raw).toEqual([]);
  });

  it("refuses through the ONE helper, so the message does not vary by route", () => {
    // Three routes each hand-rolled a correct refusal and said three different
    // things: "Invalid window", "Invalid date range", "from/to must be
    // YYYY-MM-DD". Correct three times and inconsistent, which is how the
    // fourth comes to be written without one at all.
    const src = stripComments(readFileSync(join(API_SRC, "common", "status-filter.ts"), "utf8"));
    expect(src).toMatch(/export function dateFilter/);
    expect(src).toMatch(/export function dateWindow/);
    expect(src).toMatch(/export function boundedInt/);
    // Both shapes, or the ledger's silent-drop returns.
    expect(src).toMatch(/ISO 8601/);
  });
});

/** The service files a controller injects — where the date parse usually is. */
function serviceFilesFor(controller: string): string[] {
  let text: string;
  try {
    text = readFileSync(controller, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const m of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
    if (!/service/i.test(m[1])) continue;
    out.push(join(controller, "..", `${m[1]}.ts`));
  }
  return out;
}
