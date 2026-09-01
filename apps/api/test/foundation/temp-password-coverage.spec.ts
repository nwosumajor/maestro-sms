// =============================================================================
// Which temp credentials are BOUNDED — asserted on the source, not on trust
// =============================================================================
// `tempPasswordSetAt` is what makes an unused temp password go stale. A site that
// issues one without stamping it produces a credential valid for ever, and
// nothing at runtime distinguishes that from a bounded one: both just work. So
// the only place to catch a missed site is here, at the source.
//
// This is a COVERAGE gate in the same spirit as the RLS meta-test: adding a new
// way to hand out a password should force a deliberate decision about its life,
// rather than quietly defaulting to unlimited.
// =============================================================================

import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


const SRC = join(__dirname, "..", "..", "src");
const read = (p: string) => stripComments(readFileSync(join(SRC, p), "utf8"));

/**
 * Source with comments stripped.
 *
 * These files EXPLAIN `passwordChangedAt: null` in prose right above the code
 * that uses it, so a naive count sees six writes where there are four. An
 * assertion that cannot tell a comment from a write is not an assertion — the
 * same trap the module-graph test documents.
 */
const code = (p: string) =>
  read(p)
    
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

/**
 * Paths that hand a temp password to a HUMAN ADMIN alongside a 7-day invite link,
 * or reset one. These are bounded: the credential dies with the link.
 */
const BOUNDED = [
  "operator/operator-provisioning.service.ts",
  "operator/operator-user.service.ts",
];

/**
 * Paths that issue temp passwords in BULK, delivered as printed login slips over
 * days or weeks rather than by a link. Deliberately NOT bounded yet: a 7-day
 * window would strand a school midway through handing out 500 student slips, and
 * choosing the right window there is a product decision, not a mechanical one.
 *
 * Listed rather than ignored, so the gap is visible and deliberate instead of
 * being mistaken for coverage.
 */
const UNBOUNDED_BY_DECISION = [
  "admin/student-import.service.ts",
  "parent/parent-import.service.ts",
  "admin/admin.service.ts",
  "hr/recruitment.service.ts",
];

describe("temp passwords issued with an invite link are BOUNDED", () => {
  it.each(BOUNDED)("%s stamps tempPasswordSetAt", (file) => {
    const src = code(file);
    // It issues a temp credential…
    expect(src).toMatch(/passwordChangedAt: null/);
    // …so it must also record when, or the credential never expires.
    expect(src).toContain("tempPasswordSetAt: new Date()");
  });

  it("stamps it at EVERY forced-reset site in those files, not just one", () => {
    // A file can contain several issuance paths — school provisioning creates
    // admins in bulk AND singly, and the platform console hires AND re-issues.
    // Counting keeps a newly added path from hiding behind an existing stamp.
    for (const file of BOUNDED) {
      const src = code(file);
      const forcedResets = (src.match(/passwordChangedAt: null/g) ?? []).length;
      const stamps = (src.match(/tempPasswordSetAt: new Date\(\)/g) ?? []).length;
      expect({ file, forcedResets, stamps }).toEqual({ file, forcedResets, stamps: forcedResets });
    }
  });
});

describe("the bulk-import paths are knowingly unbounded", () => {
  it.each(UNBOUNDED_BY_DECISION)("%s issues temp passwords but does not bound them", (file) => {
    const src = code(file);
    expect(src).toMatch(/tempPassword/);
    // If one of these GAINS a stamp, this test fails — which is the prompt to move
    // it into BOUNDED above, so the two lists never drift from reality.
    expect(src).not.toContain("tempPasswordSetAt: new Date()");
  });
});
