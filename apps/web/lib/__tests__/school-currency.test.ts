// =============================================================================
// A school's money, printed in somebody else's currency
// =============================================================================
// `lib/format.ts` was fixed so display follows the SCHOOL — the region rides the
// session and `useFormat()` / `regionOf()` bind the formatters to it. Components
// then went on defining their own:
//
//   const naira = (m: number) => `₦${(m / 100).toLocaleString("en-NG", …)}`;
//
// Three faults in one line. The SYMBOL is the platform's, so a Ghanaian school's
// payroll printed in naira. The LOCALE is the platform's. And `/ 100` is the
// error CLAUDE.md calls out by name: 11 of the 29 catalogued African currencies
// are zero-decimal, and the CFA franc has no minor unit at all, so dividing by
// 100 shows a hundredth of the real figure.
//
// The blast radius was staff-facing and family-facing both: HR compensation,
// staff loans, salary changes, the transport maintenance log, and the approvals
// queue where somebody signs off an amount.
//
// PLATFORM money is a different question and deliberately not covered here. The
// operator's pricing console, the public onboarding form and the marketing page
// quote what the PLATFORM charges, which really is in its own currency.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "../..");

/** Components that render a SCHOOL's money and must follow the school's region. */
const TENANT_FACING = [
  "components/hr",
  "components/transport",
  "components/hostel",
  "components/workflow",
  "components/fees",
  "components/gradebook",
  "components/lms",
  "components/attendance",
  // Added after a Ghanaian school's library page read "Fines accrued
  // ₦300,000.00" directly above a loan table printing the same fines as
  // GH₵200.00. The client island here was already correct; the SERVER PAGE
  // beside it was not — and neither this directory nor any page was scanned.
  "components/library",
];

/**
 * SERVER PAGES that render a school's money.
 *
 * The scan was components-only, so every `app/(app)/…/page.tsx` was invisible
 * to it — which is where two of these defects were living, in files whose
 * `components/` siblings had already been fixed with a comment explaining why.
 * Sibling asymmetry, and a gate that could not see half the pairs.
 */
const TENANT_PAGES = ["app/(app)"];

/**
 * Surfaces that quote the PLATFORM's own prices, where its currency is correct.
 * Listed rather than pattern-matched, so adding one is a decision.
 */
const PLATFORM_MONEY = [
  "components/operator",
  "components/billing",
  "components/public",
  "components/admissions",
  "app/page.tsx",
  "app/for-owners",
  "app/manual",
  "app/(app)/help",
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.tsx?$/.test(f) && !/__tests__/.test(f)) out.push(f);
  }
  return out;
}

/**
 * Does this file call the shared `money` helper with NO currency?
 *
 * The subtle half, and the one the three checks below cannot see. `money` from
 * `@/lib/format` is
 *
 *     money(amountMinor, currency = PLATFORM_REGION.currency, locale = …)
 *
 * so `money(x)` is a platform-currency site written with the CORRECT helper. A
 * component that was "fixed" by switching to `money()` and never given a
 * currency still prints naira for every school on earth.
 *
 * Two spellings are fine and must not be flagged: `const { money } =
 * useFormat()` (bound to the session's region) and a local binding such as
 * `const money = moneyIn(region)`. Both shadow the import.
 */
function platformDefaultedMoney(src: string): string[] {
  if (!/import\s*\{[^}]*\bmoney\b[^}]*\}\s*from\s*"@\/lib\/format"/.test(src)) return [];
  // Shadowed by a region-bound binding of the same name — not the import.
  if (/\bconst\s*\{[^}]*\bmoney\b[^}]*\}\s*=\s*useFormat\(/.test(src)) return [];
  if (/\bconst\s+money\s*=/.test(src)) return [];
  const out: string[] = [];
  for (const m of src.matchAll(/\bmoney\(/g)) {
    let i = m.index! + m[0].length;
    let depth = 1;
    let arg = "";
    while (i < src.length && depth > 0) {
      const c = src[i];
      if ("([{".includes(c)) depth += 1;
      else if (")]}".includes(c)) {
        depth -= 1;
        if (depth === 0) break;
      }
      arg += c;
      i += 1;
    }
    // Strip nested calls before looking for the argument separator.
    if (arg.trim() && !/,/.test(arg.replace(/\([^)]*\)/g, ""))) out.push(`money(${arg.trim().slice(0, 40)})`);
  }
  return out;
}

describe("tenant-facing components print the SCHOOL's currency", () => {
  const files = TENANT_FACING.flatMap((d) => walk(join(WEB, d)));

  it("covers the components it claims to", () => {
    // Guard against the scan silently finding nothing — a green pass over an
    // empty file list would prove exactly as much as no test at all.
    expect(files.length).toBeGreaterThan(20);
  });

  it("none hard-codes a currency symbol in a money formatter", () => {
    // The naira sign in a placeholder ("₦ / month") is a hint, not a rendered
    // amount; the defect is a FORMATTER that stamps it onto a real figure.
    const offenders = files
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return /`₦\$\{|₦\$\{.*toLocaleString/.test(src);
      })
      .map((f) => f.slice(WEB.length + 1));
    expect(offenders).toEqual([]);
  });

  it("none divides minor units by 100", () => {
    // The zero-decimal case. `toMajor`/`money` ask Intl how many minor units the
    // currency actually has; 100 is an assumption that is wrong 11 times in 29.
    const offenders = files
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return /\(\s*(?:m|minor|amountMinor|[a-zA-Z]+Minor)\s*\/\s*100\s*\)/.test(src);
      })
      .map((f) => f.slice(WEB.length + 1));
    expect(offenders).toEqual([]);
  });

  it("none formats money against the platform locale", () => {
    const offenders = files
      .filter((f) => /toLocaleString\("en-NG"|Intl\.NumberFormat\("en-NG"/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(WEB.length + 1));
    expect(offenders).toEqual([]);
  });
});

describe("the SERVER PAGES too, and the helper's DEFAULT argument", () => {
  // Every page under app/(app) is behind a session and renders one school's
  // data. The exceptions are the surfaces that quote the PLATFORM's own prices.
  const PLATFORM_PAGES = ["app/(app)/help", "app/(app)/billing", "app/(app)/operator"];
  const pages = TENANT_PAGES.flatMap((d) => walk(join(WEB, d))).filter(
    (f) => !PLATFORM_PAGES.some((p) => f.slice(WEB.length + 1).startsWith(p)),
  );

  it("covers the pages it claims to", () => {
    // A walk that finds nothing produces no offenders and passes green.
    expect(pages.length).toBeGreaterThan(40);
  });

  it("no school-facing page calls money() without saying which currency", () => {
    const offenders = pages
      .map((f) => [f.slice(WEB.length + 1), platformDefaultedMoney(readFileSync(f, "utf8"))] as const)
      .filter(([, calls]) => calls.length > 0)
      .map(([f, calls]) => `${f}: ${calls.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  it("nor does a tenant-facing component", () => {
    const offenders = TENANT_FACING.flatMap((d) => walk(join(WEB, d)))
      .map((f) => [f.slice(WEB.length + 1), platformDefaultedMoney(readFileSync(f, "utf8"))] as const)
      .filter(([, calls]) => calls.length > 0)
      .map(([f, calls]) => `${f}: ${calls.join(", ")}`);
    expect(offenders).toEqual([]);
  });
});

describe("the platform's own prices are a separate question", () => {
  it("those surfaces still exist and are excluded on purpose", () => {
    // If one of these is ever moved into a tenant surface the exemption should
    // be revisited, so the list is asserted rather than assumed.
    const present = PLATFORM_MONEY.filter((p) => {
      try {
        statSync(join(WEB, p));
        return true;
      } catch {
        return false;
      }
    });
    expect(present.length).toBeGreaterThanOrEqual(6);
  });
});
