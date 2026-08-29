/**
 * A DATE FOLLOWS THE SCHOOL, NOT THE PLATFORM.
 *
 * `shortDate`/`dateTime`/`longDate` take an optional region and fall back to
 * `PLATFORM_REGION` (en-NG / Africa/Lagos). That fallback is right for the
 * public site and for the operator console; it is wrong on every screen a
 * school reads about itself.
 *
 * Measured before this gate: 91 of 102 date renders took the platform default
 * and ELEVEN were region-aware — the exact mirror of the money sweep, which was
 * done and gated while the date half was left. The disputes page showed it in
 * one line: `money(d.amountMinor, d.currency)` beside four bare `shortDate`
 * calls.
 *
 * WHY IT MATTERS: `isCalendarDate` already forces a `@db.Date` to render in UTC,
 * so this is not about day-typed columns. It is about true INSTANTS — a meeting
 * time, an evidence deadline, when a notification arrived. A school east of the
 * platform sees a timestamp roll to the next day early; one west of it sees a
 * deadline a day later than it is, which on a chargeback is money lost by
 * default.
 *
 * THE TELL IS THE IMPORT, NOT THE CALL — the same trap
 * `money-is-not-divided-by-a-hundred` records. `useFormat()` returns formatters
 * already bound to the school's region, so a bare `shortDate(x)` in a component
 * that destructured it is CORRECT. What silently means "the platform's clock"
 * is a bare call in a file that imported the function straight from
 * `@/lib/format`.
 */
import { shortDate } from "../format";
import * as fs from "node:fs";
import * as path from "node:path";

const WEB = path.resolve(__dirname, "../..");
const FNS = ["shortDate", "dateTime", "longDate"];

/**
 * Surfaces whose reader is the PLATFORM, not a school — one consistent clock is
 * the point. An operator scanning many tenants, or a group director comparing
 * campuses, must not read each row in a different timezone.
 */
const PLATFORM_TIMED: Record<string, string> = {
  "app/(app)/operator/payments/page.tsx": "the owner's revenue ledger — one clock across every tenant",
  "app/(app)/operator/schools/page.tsx": "cross-tenant registry read by the platform owner",
  "app/(app)/operator/schools/[id]/page.tsx": "cross-tenant drill-down read by the platform owner",
  "app/(app)/operator/page.tsx": "the operator console's own dashboard",
  "app/(app)/operator/tenants/page.tsx": "cross-tenant registry read by the platform owner",
  "app/(app)/group/[schoolId]/page.tsx": "a director comparing campuses needs one clock, not one per campus",
  "components/operator/PlatformAnalytics.tsx": "platform-wide analytics, rendered for the owner",
};

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const strip = (s: string) => s.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");

describe("a school's dates use the school's region", () => {
  const files = [...sources(path.join(WEB, "app")), ...sources(path.join(WEB, "components"))];

  it("scanned a believable number of sources", () => {
    // A walk that finds nothing produces no offenders and passes covering
    // nothing — the failure `a-gate-must-not-pass-by-finding-nothing` names.
    expect(files.length).toBeGreaterThan(150);
  });

  it("renders no school-facing date on the platform's clock", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of files) {
      const src = strip(fs.readFileSync(file, "utf8"));
      // The tell: the function came straight from @/lib/format rather than from
      // `useFormat()`, which is already bound to the school.
      if (!new RegExp(`import\\s*{[^}]*\\b(${FNS.join("|")})\\b[^}]*}\\s*from\\s*"@/lib/format"`).test(src)) continue;
      const rel = path.relative(WEB, file);
      for (const fn of FNS) {
        // A call with no second argument takes PLATFORM_REGION.
        const bare = new RegExp(`\\b${fn}\\((?![^()]*,\\s*region)([^,()]*(?:\\([^()]*\\))?[^,()]*)\\)`, "g");
        for (const m of src.matchAll(bare)) {
          checked += 1;
          if (rel in PLATFORM_TIMED) continue;
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${rel}:${line} — ${fn}(${m[1].trim()}) takes the platform's timezone`);
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it("names no platform-timed surface that has stopped existing", () => {
    // A dangling exemption is a hole waiting for the filename to be reused.
    for (const [rel, why] of Object.entries(PLATFORM_TIMED)) {
      expect(why.length).toBeGreaterThan(20);
      expect(fs.existsSync(path.join(WEB, rel))).toBe(true);
    }
  });

  it("the region argument is load-bearing — a school east of UTC reads a different day", () => {
    // Without this the gate would pass against a `shortDate` that accepted a
    // region and ignored it: every call site would look fixed and every screen
    // would still be on the platform's clock. Same reason the naira gate also
    // asserts the SYMBOL form is still unrenderable.
    const instant = new Date("2026-08-28T14:00:00.000Z"); // afternoon in Lagos, next day in Auckland
    const lagos = shortDate(instant, { locale: "en-NG", timezone: "Africa/Lagos" });
    const auckland = shortDate(instant, { locale: "en-NG", timezone: "Pacific/Auckland" });
    expect(lagos).toContain("28");
    expect(auckland).toContain("29");
    expect(lagos).not.toEqual(auckland);
  });

  it("a calendar DATE is still rendered in UTC whatever the school's zone", () => {
    // A `@db.Date` is a DAY, not an instant: it serialises as midnight UTC, and
    // converting it into a zone west of UTC would date every Toronto register a
    // day early. `isCalendarDate` protects those, and this sweep must not have
    // broken that.
    const day = new Date("2026-08-28T00:00:00.000Z");
    expect(shortDate(day, { timezone: "America/Toronto" })).toContain("28");
    expect(shortDate(day, { timezone: "Pacific/Auckland" })).toContain("28");
  });

  it("formats no date or time from the browser's own clock", () => {
    // THE SECOND HALF OF THIS CLASS, and the half the first sweep missed. That
    // pass keyed on callers of `shortDate`/`dateTime` and could not see a
    // component formatting a date ITSELF: seventeen called
    // `toLocaleDateString(undefined, …)` and four `toLocaleTimeString()`, which
    // take the BROWSER's zone and locale.
    //
    // Worse than the ones it did find, for two reasons. They bypass
    // `isCalendarDate`, so a `@db.Date` such as a leaver's last working day
    // renders a DAY EARLY in any browser west of UTC. And a client component
    // fed by server props renders once on the server (UTC in a container) and
    // again in the browser — a hydration mismatch, which this repo's own note
    // says "a user sees as a blank page".
    //
    // `toLocaleString` is deliberately NOT matched: numbers use it for
    // thousands separators, and a rule that flagged those would be the
    // over-wide gate this repo treats as the same failure as a blind one.
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(path.join("lib", "format.ts"))) continue;
      const src = strip(fs.readFileSync(file, "utf8"));
      for (const m of src.matchAll(/\btoLocale(?:Date|Time)String\(/g)) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${path.relative(WEB, file)}:${line} — formats from the browser's clock, not the school's`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
