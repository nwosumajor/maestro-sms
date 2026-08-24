// =============================================================================
// "Every mutation writes an audit-log entry" — checked, not assumed
// =============================================================================
// It is a stated convention in CLAUDE.md and a Golden Rule for minors' data, and
// nothing verified it. Extracting all 502 mutating routes, resolving each to the
// service method it calls, and following delegation, found one real gap:
//
//   POST /hr/attendance/:slug/events  ->  ingestDeviceEvents
//
// A biometric terminal posts an HMAC-signed batch and `staff_attendance` rows
// are created for real members of staff. Every OTHER write in that same service
// is audited — the kiosk clock-in, the admin mark, the corrections — and this
// one, over a PUBLIC endpoint on the say-so of a device, recorded nothing. A
// terminal with a stale clock, a drifted enrolment map or a leaked secret left
// no trace of what it had claimed, and staff attendance is read for lateness and
// feeds pay decisions.
//
// // GOTCHA, twice over, and the reason this file follows delegation: a naive
// scan of the method the CONTROLLER calls reported 71 offenders, nearly all
// false. `markAttendance` audits inside `applyRegister`; `advanceToNextTerm`
// audits inside a free function it passes `this.audit` to; `applyLmsGrades`
// audits in the service it delegates to. A gate that cries wolf 70 times is one
// nobody runs twice.
//
// The exemptions below are DECISIONS. Most are "the row IS the record": a
// gateway webhook is logged in `gateway_event` before dispatch, a credit ledger
// is append-only, an inbox read is not an event worth a second row. Writing them
// down is the point — an unexplained absence and a considered one look identical
// in a codebase.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "../../src");
const ROUTE = /@(Get|Post|Put|Patch|Delete)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;
const CALL = /return\s+this\.(\w+)\.(\w+)\(|await\s+this\.(\w+)\.(\w+)\(/;
const AUDIT = /this\.audit\.record|auditLog\.create|workflowAuditLog\.create|this\.log\(|this\.auditOwn\(|audit: this\.audit/;
// Both shapes: a helper on this service, AND a method on an injected one —
// `applyLmsGrades` delegates to `this.termResults.applyAssignmentComponent`,
// which the narrower pattern could not see and reported as unaudited.
const SELF = /this\.(\w+)\(|this\.\w+\.(\w+)\(/g;

const ALLOWED: Record<string, string> = {
  "POST /billing/stripe/webhook": "The verified Stripe event is written to `gateway_event` before dispatch, exactly as the Paystack route is; that append-only log is the record.",
  "POST /notifications/credits/reconcile/run": "Reconciles the message-credit ledger, which is append-only — every correction it makes IS a ledger row.",
  "POST /payments/webhook": "The verified event is written to `gateway_event` BEFORE dispatch; that append-only log is the record.",
  "POST /payments/mobile-money/callback/:provider": "Same — unsigned rails settle from our own MobileMoneyIntent, and the intent plus the settlement are the trail.",
  "PUT /payments/mobile-money/callback/:provider": "The same callback, over the PUT method MTN uses rather than POST; identical handling.",
  "POST /payments/mobile-money/charge": "Writes the MobileMoneyIntent before the prompt goes out; that row is the record of what was asked for.",
  "POST /invoices/:id/pay/init": "Starts a checkout. Nothing has moved yet, and the settlement that posts it is audited.",
  "POST /students/:id/prepay/init": "Starts a prepayment checkout. Nothing has moved, and the credit entry that results is audited.",
  "POST /public/admissions/:id/pay/init": "Starts an admission-form-fee checkout; the webhook that settles it stamps the application.",
  "POST /invoices/:id/pay/confirm": "Verify-on-return delegates to the one settlement path, which audits the posting.",
  "POST /notifications/credits/verify": "Credits land as rows in an append-only ledger; the ledger IS the audit.",
  "POST /notifications/credits/delivery-status": "Refunds a credit for a failed send into the same append-only ledger.",
  "POST /notifications/:id/read": "Reading your own inbox. An audit row per read would bury the log it is meant to make readable.",
  "POST /notifications/read-all": "Marking your own inbox read, in bulk. Auditing a read would bury the log it exists to make readable.",
  "POST /messages/threads/:id/reply": "The message itself is the record, with its author and timestamp; a second copy adds nothing.",
  "POST /transport/locations": "Continuous GPS pings from a vehicle. The location rows are the record and an audit row per ping would be larger than the data.",
  "POST /public/onboarding-requests": "Unauthenticated: there is no actor. The onboarding request row is the record, and provisioning from it IS audited.",
  "POST /hr/recruitment/:slug/apply": "Unauthenticated job application; the applicant row is the record.",
  "POST /public/documents/upload-url": "Mints an upload capability for a family holding a signed link; the CONFIRM that accepts the bytes is what matters and is recorded on the submission row.",
  "POST /documents/submissions/upload-url": "Mints an upload capability for a signed-in uploader; the submission row records who supplied what.",
  "POST /discipline/complaints/:id/evidence/presign": "Same — the evidence row records who attached what.",
  "POST /tasks/:id/attachment/presign": "Mints an upload capability; the attachment row records who attached it and when.",
  "PUT /local-storage/*": "The DEV storage stub, registered only when STORAGE_PROVIDER is not s3.",
  "POST /operator/payment-channels/:channel/test": "Sends a test call to a gateway and changes nothing.",
  "POST /fees/settlement/resolve": "Records the outcome of a settlement enquiry onto the payment rows themselves.",
  "PUT /scholarships/applications/:id": "The applicant editing their own draft before submission; submission is audited.",
  "POST /public/admissions": "Unauthenticated intake: there is no actor. The application row is the record, and every staff decision on it IS audited.",
  "POST /integrity/retention/run": "The purge writes an immutable RetentionRun record — a fuller trail than an audit line.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    // Controllers and services only. Reading all 440 source files into memory
    // and holding them for the run pushed the whole suite over the Node heap
    // under --runInBand — the gate aborted the very suite it belongs to. These
    // 241 are the only files that can define a controller's target anyway.
    else if (/\.(controller|service)\.ts$/.test(f)) out.push(f);
  }
  return out;
}

/**
 * Resolve a controller's `this.<prop>.<method>()` to the ACTUAL service file,
 * then look the method up there. Two earlier versions got this wrong in opposite
 * directions, and both were caught by mutation testing rather than by reading:
 *
 *   keyed by method NAME across all files — `this.db.runAsTenant(...)` matched
 *   every `runAsTenant` in the codebase, including ones that audit, so the gate
 *   went green for the wrong reason and deleting the audit call it exists for did
 *   not fail it;
 *
 *   then excluding plumbing names — which also excluded genuine service methods
 *   called `create` and `update`, reporting eleven audited routes as offenders.
 *
 * Resolving the class removes both: `create` on AlumniService is found in
 * AlumniService, and `runAsTenant` on the tenant DB is not a service method at
 * all.
 */
const FILES = walk(API_SRC);
const SRC = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));

/** ClassName -> the file that exports it. */
const classFile = new Map<string, string>();
for (const [f, src] of SRC) {
  for (const m of src.matchAll(/export class (\w+)/g)) classFile.set(m[1], f);
}

/** file -> (constructor property -> ClassName). */
function injected(file: string): Map<string, string> {
  const src = SRC.get(file) ?? "";
  const ctor = /constructor\(([\s\S]*?)\)\s*\{/.exec(src);
  const out = new Map<string, string>();
  if (!ctor) return out;
  for (const m of ctor[1].matchAll(/(?:private|public|protected|readonly|\s)+(\w+)\s*[?]?:\s*(\w+)/g)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/** The body of `method` as defined in `file`, if it is defined there. */
function bodyIn(file: string, method: string): string | null {
  const src = SRC.get(file);
  if (!src) return null;
  const m = new RegExp(`\\n  (?:private |public |protected )?(?:async )?${method}\\s*[(<]`).exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  const nxt = /\n  (?:private |public |protected )?(?:async )?\w+\s*[(<]/.exec(src.slice(start));
  return src.slice(start, start + (nxt ? nxt.index! : src.length - start));
}

/** Does `file::method` audit, following delegation up to two hops? */
function auditsIn(file: string, method: string, depth = 0, seen = new Set<string>()): boolean {
  const key = `${file}::${method}`;
  if (seen.has(key) || depth > 2) return false;
  seen.add(key);
  const body = bodyIn(file, method);
  if (!body) return false;
  if (AUDIT.test(body)) return true;
  const props = injected(file);
  // A helper in the same class.
  for (const m of body.matchAll(/this\.(\w+)\(/g)) {
    if (m[1] !== method && auditsIn(file, m[1], depth + 1, seen)) return true;
  }
  // A method on an injected service, resolved to that service's own file.
  for (const m of body.matchAll(/this\.(\w+)\.(\w+)\(/g)) {
    const target = classFile.get(props.get(m[1]) ?? "");
    if (target && auditsIn(target, m[2], depth + 1, seen)) return true;
  }
  return false;
}

describe("every mutating route", () => {
  const routes: Array<{ key: string; method: string; file: string }> = [];
  for (const f of FILES.filter((x) => x.endsWith(".controller.ts"))) {
    const src = readFileSync(f, "utf8");
    const prefix = /@Controller\(\s*["'`]([^"'`]*)["'`]\s*\)/.exec(src)?.[1] ?? "";
    const hits = [...src.matchAll(ROUTE)];
    for (const [i, m] of hits.entries()) {
      if (m[1] === "Get") continue;
      const block = src.slice(m.index!, hits[i + 1]?.index ?? src.length);
      // A MANUAL SWEEP TRIGGER IS RECORDED IN THE JOB-RUNS CATALOGUE.
      //
      // `this.jobRuns.record("fee.reconcile", "MANUAL", () => svc.sweep())`
      // writes an immutable JobRun row carrying who triggered it, when, how long
      // it took and what it returned — a fuller trail than an audit line, and
      // the one an operator actually reads. Expressed as a rule rather than as
      // sixteen identical exemptions, because it is one fact about the codebase.
      if (/this\.jobRuns\.record\(/.test(block)) continue;
      const c = CALL.exec(block);
      if (!c) continue;
      const prop = c[1] ?? c[3];
      const target = classFile.get(injected(f).get(prop) ?? "");
      const path = ("/" + [prefix, m[2] ?? ""].filter(Boolean).join("/")).replace(/\/+/g, "/");
      routes.push({ key: `${m[1].toUpperCase()} ${path}`, method: c[2] ?? c[4], file: target ?? "" });
    }
  }

  it("was actually found — the extraction has not broken", () => {
    expect(routes.length).toBeGreaterThan(400);
  });

  it("writes an audit entry, or is exempted by name with a reason", () => {
    const offenders = routes
      .filter((r) => !(r.key in ALLOWED) && r.file && !auditsIn(r.file, r.method))
      .map((r) => `${r.key} -> ${r.method}()`);
    expect(offenders).toEqual([]);
  });

  it("records the biometric ingestion that was the one real gap", () => {
    const f = classFile.get("StaffAttendanceService") ?? classFile.get("AttendanceService") ?? "";
    expect([f !== "", auditsIn(f, "ingestDeviceEvents")]).toEqual([true, true]);
  });

  it("gives every exemption a reason", () => {
    for (const [route, why] of Object.entries(ALLOWED)) {
      expect([route, why.length > 40]).toEqual([route, true]);
    }
  });
});
