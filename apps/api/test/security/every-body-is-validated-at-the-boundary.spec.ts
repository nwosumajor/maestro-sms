// =============================================================================
// One request body of 339 was never validated
// =============================================================================
// "All API inputs validated (Zod or class-validator) at the boundary" is a
// stated convention here, and 334 of 339 `@Body` parameters follow it. Four of
// the remaining five are deliberate and stay: three gateway callbacks whose
// shape we do not control — parsed defensively and settled from OUR OWN records,
// never from what the caller sent — and the dev storage stub, which takes raw
// bytes rather than JSON.
//
// The fifth was an ordinary authenticated endpoint. `POST /members/scan/:code`
// hand-checked `purpose` in the method body and did not check `note` at all,
// passing it through as `body.note ?? null`. Both consequences measured against
// the running service:
//
//   note: { a: 1 }              -> HTTP 500. `note?.trim()` on an object throws,
//                                  so a client's mistake became an internal
//                                  error with a stack trace and a Sentry event
//                                  instead of a 400.
//   note: 90,000 characters     -> HTTP 201, and all 90,000 landed in
//                                  `scan_event` — APPEND-ONLY, on the busiest
//                                  desk in the school, a table this codebase has
//                                  already sized at tens of millions of rows.
//
// Both are 400 now, and an ordinary scan is unchanged.
//
// The lesson is not "add a pipe". It is that a hand-rolled check covers what its
// author was thinking about: `purpose` was validated because it drives a branch,
// and `note` was not because it is only stored. Stored is where the damage was.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");

/** Bodies deliberately not schema-validated, each with the reason. */
const UNVALIDATED_BY_DESIGN: Record<string, string> = {
  "payments/mobile-money.controller.ts":
    "Provider callbacks. The body shape belongs to M-Pesa / MTN / Airtel and each differs; it is parsed defensively and the payment is settled from OUR MobileMoneyIntent, never from what the callback claims. A schema here would reject a rail's real payload and lose money.",
  "notifications/notification.controller.ts":
    "Twilio's delivery-status callback, verified by signature over the raw form body. Twilio owns the field set and adds to it.",
  "documents/local-storage.controller.ts":
    "The DEV storage stub takes raw bytes on a PUT, not JSON. Registered only when STORAGE_PROVIDER is not s3.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".controller.ts")) out.push(f);
  }
  return out;
}

/** Each `@Body(...)` decorator's argument list, balanced. */
function bodies(src: string): Array<{ arg: string; line: number }> {
  const out: Array<{ arg: string; line: number }> = [];
  for (const m of src.matchAll(/@Body\(/g)) {
    let i = m.index! + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") depth -= 1;
      i += 1;
    }
    out.push({ arg: src.slice(m.index! + m[0].length, i - 1), line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

const FILES = walk(SRC);

describe("every request body", () => {
  it("scanned something — this gate can otherwise pass by finding nothing", () => {
    expect(FILES.length).toBeGreaterThan(40);
  });

  it("is a set worth checking", () => {
    const total = FILES.reduce((n, f) => n + bodies(readFileSync(f, "utf8")).length, 0);
    expect(total).toBeGreaterThan(300);
  });

  it("passes through a validation pipe, or is exempted by name with a reason", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const rel = file.slice(SRC.length + 1);
      if (UNVALIDATED_BY_DESIGN[rel]) continue;
      for (const b of bodies(readFileSync(file, "utf8"))) {
        if (/Pipe/.test(b.arg)) continue;
        offenders.push(`${rel}:${b.line} — @Body(${b.arg.trim() || ""}) with no validation`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the exemptions honest — each names a file that exists", () => {
    for (const rel of Object.keys(UNVALIDATED_BY_DESIGN)) {
      expect(FILES.some((f) => f.endsWith(`/src/${rel}`))).toBe(true);
    }
  });

  it("gives every exemption a reason somebody could argue with", () => {
    for (const [rel, why] of Object.entries(UNVALIDATED_BY_DESIGN)) {
      expect([rel, why.length > 80]).toEqual([rel, true]);
    }
  });
});

describe("the scan note specifically", () => {
  const src = readFileSync(join(SRC, "certificate/member-scan.controller.ts"), "utf8");

  it("is bounded, because it lands in an append-only table on a busy desk", () => {
    expect(src).toMatch(/note:\s*z\.string\(\)\.max\(\d+\)/);
  });

  it("takes its purposes from SCAN_PURPOSES rather than restating them", () => {
    // A second list of the valid purposes is a second thing to keep in step.
    expect(src).toMatch(/z\.enum\(SCAN_PURPOSES\)/);
  });
});
