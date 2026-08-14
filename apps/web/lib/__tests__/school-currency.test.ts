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
];

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
