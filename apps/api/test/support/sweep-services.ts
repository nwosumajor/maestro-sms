// =============================================================================
// The set of background sweeps, COMPUTED rather than listed
// =============================================================================
// Every BullMQ processor names the service it drives, so the processors are the
// discoverable source of truth for "what runs on a schedule".
//
// This was duplicated reasoning: `a-sweep-that-skipped-a-school-and-said-nothing`
// computed its set exactly this way and said so in a comment, while
// `a-sweep-that-was-behind-and-said-nothing` — in the same directory, about the
// same sweeps — carried a HAND-KEPT array of four filenames. A fifth capped
// sweep (the overdue fee reminder, which chases families for unpaid invoices)
// was therefore never checked, and shipped capped at 2,000 with no backlog and
// no `orderBy` at all. The gate that existed for that defect passed, covering
// nothing about it.
//
// A gate whose SET is hand-maintained only ever guards what somebody remembered.
// =============================================================================

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { stripComments } from "./strip-comments";

export const API_SRC = join(__dirname, "../../src");

export function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkTs(full, out);
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

export interface SweepService {
  processor: string;
  service: string;
  file: string;
  /** Comment-stripped, so an assertion can never be satisfied by prose. */
  src: string;
}

/** Every service a background processor drives, resolved from its imports. */
export function sweepServices(): SweepService[] {
  const out: SweepService[] = [];
  const seen = new Set<string>();
  for (const proc of walkTs(API_SRC).filter((f) => f.endsWith(".processor.ts"))) {
    const text = readFileSync(proc, "utf8");
    for (const m of text.matchAll(/import\s+\{[^}]*\}\s+from\s+"(\.[^"]+\.service)"/g)) {
      const file = resolve(dirname(proc), `${m[1]}.ts`);
      if (!existsSync(file) || seen.has(file)) continue;
      seen.add(file);
      out.push({ processor: proc, service: m[1], file, src: stripComments(readFileSync(file, "utf8")) });
    }
  }
  return out;
}

/**
 * Services a sweep reaches THROUGH another service.
 *
 * The overdue-reminder processor drives `FeeOpsService`, which calls
 * `FeesService.sendFeeReminders` — and the capped read lives in the callee. A
 * gate that only inspected the directly-imported service could not see it, so
 * one hop is followed.
 */
export function sweepServicesWithCallees(): SweepService[] {
  const direct = sweepServices();
  const out = [...direct];
  const seen = new Set(direct.map((d) => d.file));
  for (const d of direct) {
    const raw = readFileSync(d.file, "utf8");
    for (const m of raw.matchAll(/import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"(\.[^"]+\.service)"/g)) {
      const file = resolve(dirname(d.file), `${m[1]}.ts`);
      if (!existsSync(file) || seen.has(file)) continue;
      seen.add(file);
      out.push({ processor: d.processor, service: m[1], file, src: stripComments(readFileSync(file, "utf8")) });
    }
  }
  return out;
}

/** A literal `take:` bound — the thing that makes a read partial. */
export function hasLiteralTake(src: string): boolean {
  // A CAP HAS MORE THAN ONE SPELLING, and a detector that knows one of them
  // silently stops covering a sweep the day it is rewritten. The declined-
  // applicant purge moved from `take: 500` to a raw `LIMIT ${RETENTION_BATCH}`
  // — for a good reason, it had to join across two tables — and dropped out of
  // this gate's set entirely, taking its backlog requirement with it. The gate
  // one file over was rewritten to COMPUTE its set for exactly this reason;
  // computing the set is no help if the predicate that filters it is blind.
  return (
    /take:\s*\d{2,}/.test(src) ||
    /take:\s*[A-Z_]{4,}/.test(src) ||
    /\bLIMIT\s+\$\{[A-Za-z_][\w.]*\}/.test(src) ||
    /\bLIMIT\s+\d{2,}/.test(src)
  );
}

/**
 * The METHOD a processor invokes, and that method's body only.
 *
 * Checking the whole service file is too wide and teaches exemptions: the
 * feedback service has a `take: 100` on a user's own list, notifications a
 * capped "99+" count, message-credits a 20-row low-balance peek. None of those
 * is a sweep leaving work behind, and a gate that flagged them would be argued
 * with rather than fixed. What matters is the read inside the method the
 * SCHEDULE actually calls.
 */
/** Receivers that are infrastructure, not a sweep's collaborator. */
const NOT_A_SERVICE = new Set(["logger", "runs", "audit", "config", "prisma", "db"]);
/** Methods that are plumbing wherever they appear. */
const NOT_A_SWEEP = new Set(["log", "warn", "error", "debug", "record", "emit"]);

export function sweptMethods(): Array<{ processor: string; method: string; file: string; body: string }> {
  const out: Array<{ processor: string; method: string; file: string; body: string }> = [];
  const all = sweepServicesWithCallees();
  for (const s of all) {
    const proc = readFileSync(s.processor, "utf8");
    for (const m of proc.matchAll(/await\s+this\.\w+\.(\w+)\(/g)) {
      const method = m[1];
      if (method === "record") continue; // the job-runs wrapper, not the sweep
      const body = methodBody(s.src, method);
      if (!body) continue;
      out.push({ processor: s.processor, method, file: s.file, body });
      // ONE HOP. The overdue-reminder processor calls `FeeOpsService
      // .remindOverdue()`, which calls `FeesService.sendFeeReminders()` — and
      // the capped read is in the callee. A gate that stopped at the method the
      // processor names would not have seen the defect it exists for.
      for (const c of body.matchAll(/this\.(\w+)\.(\w+)\(/g)) {
        const [, receiver, inner] = c;
        // `this.logger.log(...)` is not a service call, and a `log` method
        // exists on plenty of services — following it matched everything and
        // named every finding "log()". Filter the RECEIVER, not the name.
        if (NOT_A_SERVICE.has(receiver) || NOT_A_SWEEP.has(inner)) continue;
        if (inner === method) continue;
        for (const other of all) {
          if (other.file === s.file) continue;
          const innerBody = methodBody(other.src, inner);
          if (innerBody) out.push({ processor: s.processor, method: inner, file: other.file, body: innerBody });
        }
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((o) => {
    const k = `${o.file}::${o.method}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A method's body by brace matching — enough for "what does this method read". */
export function methodBody(src: string, name: string): string | null {
  const m = new RegExp(`\\b(?:async\\s+)?${name}\\s*\\(`).exec(src);
  if (!m) return null;
  // Skip the PARAMETER LIST, then the return type, before looking for the body.
  // Taking the first `{` after the name lands inside `): Promise<{ reminded:
  // number … }> {` and returns the TYPE as the body — which is why
  // `sendFeeReminders`, whose read this gate exists to check, looked like a
  // method with no `take` in it at all.
  let k = src.indexOf("(", m.index);
  let paren = 0;
  for (; k < src.length; k += 1) {
    if (src[k] === "(") paren += 1;
    else if (src[k] === ")") {
      paren -= 1;
      if (paren === 0) break;
    }
  }
  // From the end of the params, the body's `{` is the first one not nested in a
  // generic return type.
  let angle = 0;
  let i = -1;
  for (let j = k + 1; j < src.length; j += 1) {
    const c = src[j];
    if (c === "<") angle += 1;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (c === "{" && angle === 0) {
      i = j;
      break;
    }
  }
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return null;
}
