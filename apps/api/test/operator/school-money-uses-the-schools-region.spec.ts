// =============================================================================
// A client island rendering a school's money in the platform's currency
// =============================================================================
// `money()` from `@/lib/format` defaults to `PLATFORM_REGION.currency`. That is
// correct for the PLATFORM's own figures — MRR, a scholarship award, a
// subscription charge — and wrong for anything belonging to a SCHOOL, which
// bills in its own currency. The region rides the session, and `useFormat()` is
// how a client island reaches it.
//
// Three components still used the platform default for school money: transport
// FARES, a library FINE, and a pupil's OUTSTANDING FEES on the scholarship
// portal. A school billing in cedis read all of them in naira.
//
// // THE SCHOLARSHIP PORTAL IS THE INTERESTING ONE, and why this is not a
// blanket rule: it renders BOTH. The award is platform money and must keep the
// platform helper; only the pupil's fees move. A sweep that converted every
// `money()` in that file would have been a second wrong answer.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const WEB = join(__dirname, "../../../web/components");

/** Components that legitimately render PLATFORM money with the default helper. */
const PLATFORM_MONEY: Record<string, string> = {
  "operator/PlatformAnalytics.tsx": "MRR, ARPA and at-risk revenue — the platform's own book.",
  "operator/ScholarshipAdmin.tsx": "programme budgets and awards, denominated in the platform's currency.",
  "billing/MessageCreditsCard.tsx":
    "message-credit bundles — a platform product, priced in the platform's currency.",
  "scholarship/SchoolApplications.tsx": "the AWARD offered by a platform-sponsored programme.",
  "scholarship/ScholarshipPortal.tsx":
    "renders BOTH — the award is platform money and keeps `money`; the pupil's " +
    "outstanding fees use `schoolMoney` from useFormat().",
};

function tsx(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsx(p));
    else if (e.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("school money uses the school's region", () => {
  const files = tsx(WEB);

  it("scanned a believable number of components", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no component calls the platform-pinned helper with no currency", () => {
    // THE CALL SITE IS THE TELL, NOT THE IMPORT. Most of these files import
    // `money` and pass a currency at every call — the fees and group work is
    // already done. A bare `money(x)` is what silently means "the platform's
    // currency", and a file that rebinds `money` locally (useFormat, or a
    // DisplayRegion prop on a server component) is not using the default at all.
    //
    // My first version keyed on the import and flagged 17 files, nearly all
    // correct — the same over-wide gate this repo keeps recording.
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.replace(`${WEB}/`, "");
      const src = readFileSync(f, "utf8");
      if (!/import \{[^}]*\bmoney\b[^}]*\} from "@\/lib\/format"/.test(src)) continue;
      // Locally rebound: whatever `money` means here, it is not the default.
      if (/const \{[^}]*\bmoney\b[^}]*\} = useFormat\(\)/.test(src)) continue;
      if (/DisplayRegion/.test(src)) continue;
      if (PLATFORM_MONEY[rel]) continue;
      // A single-argument call takes the platform default.
      const bare = [...src.matchAll(/\bmoney\(([^,()]|\([^()]*\))*\)/g)]
        .map((m) => m[0])
        .filter((c) => !c.includes(","));
      if (bare.length > 0) offenders.push(`${rel}: ${bare[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the components that were converted now take it from the session", () => {
    for (const rel of [
      "transport/TransportManager.tsx",
      "library/LibraryManager.tsx",
      "transport/TransportOps.tsx",
      "fees/PendingPayments.tsx",
      "hostel/HostelManager.tsx",
      "hr/EmployeeRow.tsx",
      "hr/PayrollManager.tsx",
    ]) {
      expect(readFileSync(join(WEB, rel), "utf8")).toMatch(/useFormat\(\)/);
    }
  });

  it("names only files that still exist", () => {
    for (const rel of Object.keys(PLATFORM_MONEY)) {
      expect(() => readFileSync(join(WEB, rel), "utf8")).not.toThrow();
    }
  });
});
