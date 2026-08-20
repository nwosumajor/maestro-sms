// =============================================================================
// Which services write without recording that they did?
// =============================================================================
// "Every mutation writes an audit-log entry (actor, action, entity, school_id,
// ts)" — CLAUDE.md. Nothing checked it. Services are unit-tested with a MOCKED
// audit recorder, which proves the call is made where somebody wrote one and
// says nothing about the ones where nobody did.
//
// Running real mutations found 15 of 16 recorded. This finds the other kind: a
// service that takes no audit dependency AT ALL, so no amount of reading its
// tests would reveal the omission. That scan named five, and the interesting
// thing is that four were right:
//
//   workflow.service       — keeps its own immutable WorkflowAuditLog, which is
//                            the approval engine's record and a stronger one.
//   public.service         — the public intake (admissions, careers) runs with
//                            NO actor by design: `audit_log.actorId` is a
//                            foreign key and an applicant has no user row yet.
//   mobile-money.service   — writes intents and callback state; the money posts
//                            through InvoiceSettlementService, which audits. The
//                            one posting path is the one that records.
//   auth.service           — fixed in #187 (login, lockout, password change).
//
//   messaging.service      — the real gap, and this file's reason for existing.
//                            A teacher opening a private thread with a pupil
//                            left no record, while creating a timetable room
//                            did. #183 widened exactly that capability.
//
// The allow-list below is the point. Adding a service to it should be an act of
// deliberation with a reason written down, which is a very different thing from
// forgetting.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


const SRC = join(__dirname, "../../src");

function services(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) services(f, out);
    else if (f.endsWith(".service.ts") && !f.endsWith(".spec.ts")) out.push(f);
  }
  return out;
}

/**
 * Services that write to tenant tables and deliberately record nothing here,
 * each with the reason. Anything NOT on this list must audit.
 */
const DELIBERATELY_UNAUDITED: Record<string, string> = {
  "workflow/workflow.service.ts": "keeps its own immutable WorkflowAuditLog",
  "public/public.service.ts": "public intake has no actor — actorId is an FK",
  "payments/mobile-money.service.ts": "money posts through the audited settlement path",
};

describe("every service that writes, records", () => {
  const offenders: string[] = [];
  for (const file of services(SRC)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("runAsTenant")) continue;
    const writes = (
      src.match(/tx\.[a-zA-Z]+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/g) ?? []
    ).length;
    if (writes === 0) continue;
    const audits = /AUDIT_LOG_SERVICE|this\.audit\.record\(|this\.log\(tx/.test(src);
    const rel = file.slice(SRC.length + 1);
    if (!audits && !(rel in DELIBERATELY_UNAUDITED)) offenders.push(`${rel} (${writes} writes)`);
  }

  it("no service writes to tenant tables with no audit dependency at all", () => {
    expect(offenders).toEqual([]);
  });

  it("the exemptions are still real services", () => {
    // A stale exemption silently widens the rule above.
    for (const rel of Object.keys(DELIBERATELY_UNAUDITED)) {
      expect(() => statSync(join(SRC, rel))).not.toThrow();
    }
  });
});

describe("messaging records the channel", () => {
  const src = readFileSync(join(SRC, "communication/messaging.service.ts"), "utf8");

  it("audits thread creation", () => {
    expect(src).toMatch(/action: "message\.thread\.create"/);
  });

  it("flags whether the recipient is a pupil", () => {
    // So the safeguarding question — which adults opened channels with which
    // children — is one query, and stays answerable after a pupil leaves and
    // loses the role that would have answered it retrospectively.
    expect(src).toMatch(/recipientIsStudent/);
  });

  it("records the subject and NEVER the body", () => {
    // Bounded to the metadata line itself: a fixed-length window ran past the
    // call into `reply(..., body)` and failed on an unrelated match.
    const metadata = src.match(/action: "message\.thread\.create"[\s\S]*?metadata: \{([^}]*)\}/)?.[1];
    expect(metadata).toBeDefined();
    expect(metadata).toMatch(/subject: input\.subject/);
    expect(metadata).not.toMatch(/body/);
  });
});
