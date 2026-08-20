// =============================================================================
// Nothing recorded that anyone had signed in
// =============================================================================
// The security-incident runbook tells an on-call engineer, at step 4 of "exposed
// credentials": "Audit what the credential touched via audit_log." The audit log
// records what an account DID — every create, every update. It recorded nothing
// about the account being USED. No sign-in, no failed attempt, no lockout.
//
// So the trail began after the attacker was already inside. "When did they get
// in?" and "how many accounts did they try?" had no answer in the one place the
// runbook sends you to look.
//
// The gap was easy to miss because half of this surface was already correct.
// SecurityService audits MFA enrolment, MFA disable and every step-up — it takes
// an AuditLogService and uses it. AuthService, which owns login, lockout and the
// self-service password change, took no audit dependency at all. Reading either
// service alone, nothing looks wrong.
//
// What the operator COULD see made the hole look smaller still: `operator.user.
// unlock` and `operator.user.password_reset` were both recorded. The remedies
// were audited; the events that caused them were not. An operator saw "I
// unlocked this account" with nothing to say why it locked, when, or after how
// many attempts.
//
// Deliberately NOT audited: an attempt against an email that matches no account.
// There is no actor to attribute it to (`audit_log.actorId` is a foreign key)
// and no tenant to file it under. The control for that is the login rate limiter
// and the edge WAF, not this table.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


const AUTH = readFileSync(join(__dirname, "../../src/foundation/auth.service.ts"), "utf8");
const SECURITY = readFileSync(join(__dirname, "../../src/security/security.service.ts"), "utf8");

describe("the login path records what happened", () => {
  it("a successful sign-in is recorded", () => {
    expect(AUTH).toMatch(/action: "auth\.login"/);
  });

  it("a failed password is recorded, and a lockout is recorded as a lockout", () => {
    // One record, two actions: the Nth failure is a different event from the
    // ones before it, and an operator triaging a locked account is looking for
    // exactly that distinction.
    expect(AUTH).toMatch(/action: nowLocked \? "auth\.account\.locked" : "auth\.login\.failed"/);
  });

  it("the failure record carries the attempt count", () => {
    // "Locked after 3" and "locked after 300" are different incidents.
    expect(AUTH).toMatch(/metadata: \{ failedLoginCount: fails, locked: nowLocked \}/);
  });

  it("a self-service password change is recorded", () => {
    // The operator-initiated reset was already audited; the user's own was not,
    // and changing the password is what an attacker does first.
    expect(AUTH).toMatch(/action: "auth\.password\.changed"/);
  });
});

describe("the records are written where they cannot drift from the state", () => {
  it("the failure audit is inside the same transaction as the counter update", () => {
    // The counter write COMMITS deliberately (the service returns a status and
    // throws outside the tx). If the audit were written after that, a crash
    // between them would leave a locked account with nothing explaining it.
    const block = AUTH.slice(AUTH.indexOf("const fails ="), AUTH.indexOf('return nowLocked ?'));
    expect(block).toMatch(/tx\.user\.update/);
    expect(block).toMatch(/this\.audit\.record\(/);
    expect(block.indexOf("tx.user.update")).toBeLessThan(block.indexOf("this.audit.record("));
    expect(block).toMatch(/\n\s*tx,\n\s*\);/);
  });

  it("every auth audit call passes the transaction", () => {
    // AuditLogService DROPS an entry that arrives without one — it logs an error
    // and returns — so a missing `tx` is a silently unrecorded event.
    const calls = [...AUTH.matchAll(/this\.audit\.record\(([\s\S]*?)\n\s*\);/g)];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c[1]).toMatch(/,\s*\n?\s*tx\s*,?\s*$/);
  });
});

describe("what was already correct, and must stay so", () => {
  it("SecurityService still audits MFA and step-up", () => {
    // Checked because the first pass of this review wrongly concluded MFA was
    // unaudited — the calls go through a `log()` helper, so a grep for
    // `action: "` misses them. The gap was never here.
    for (const action of ["security.mfa.enroll", "security.mfa.enabled", "security.mfa.disabled"]) {
      expect(SECURITY).toContain(action);
    }
    expect(SECURITY).toMatch(/private async log\(/);
  });

  it("never records the password itself, in any form", () => {
    // The one thing that would make this worse than no audit at all.
    const auditCalls = [...AUTH.matchAll(/this\.audit\.record\(([\s\S]*?)\n\s*\);/g)].map((m) => m[1]);
    for (const c of auditCalls) {
      expect(c).not.toMatch(/password(?!Changed|\.changed)/i);
      expect(c).not.toMatch(/passwordHash|newPassword|currentPassword/);
    }
  });
});
