// =============================================================================
// The three ways a password is set, none of them written down
// =============================================================================
// Found by sweeping every service method that writes to the database for a
// matching audit call — the Golden Rule is that every mutation records one. Most
// of what the sweep surfaced was defensible (game state machines, a user marking
// their own notifications read, webhook paths with no actor to attribute). These
// three were not.
//
// The platform already records `auth.login`, `auth.login.failed`,
// `auth.account.locked`, the in-app `auth.password.changed`, and the operator's
// forced `operator.user.password_reset`. What it did not record is every way a
// password is actually set FROM OUTSIDE the app:
//
//   * requesting a reset link
//   * completing that reset  ← sets a new password hash
//   * accepting an invite    ← sets an account's FIRST password
//
// The audit log is where a school answers "how did somebody get into this
// account", and an emailed reset link is the likeliest way in. An investigator
// looking at a compromised principal's account saw failed logins, then
// successful logins from somewhere new, and nothing at all in between to explain
// how the password had changed. The screens built for exactly this question —
// the audit viewer and the recertification anomaly report — were blind to the
// one event that matters most.
//
// These routes are unauthenticated but NOT anonymous: the signed token names the
// user, so there is a real actor and a real school to file the row under. Never
// the token, never the password, never the email address.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


const SRC = readFileSync(join(__dirname, "../../src/public/public.service.ts"), "utf8");
const bodyOf = (name: string): string => {
  const at = SRC.indexOf(`async ${name}(`);
  expect(at).toBeGreaterThan(-1);
  return SRC.slice(at, at + 2200);
};

describe("every credential-setting path records one event", () => {
  it("completing a password reset", () => {
    expect(bodyOf("confirmPasswordReset")).toMatch(/auditCredentialEvent\([^)]*"auth\.password\.reset\.completed", tx\)/);
  });

  it("accepting an invite — an account's first password", () => {
    expect(bodyOf("acceptInvite")).toMatch(/auditCredentialEvent\([^)]*"auth\.invite\.accepted", tx\)/);
  });

  it("requesting a reset link", () => {
    // Worth recording on its own: a run of requests nobody completed is somebody
    // probing an account, and that is a story an investigator should be able to
    // read afterwards.
    expect(bodyOf("deliverPasswordReset")).toMatch(
      /auditCredentialEvent\([^)]*"auth\.password\.reset\.requested", tx\)/,
    );
  });
});

describe("how they are recorded", () => {
  it("in the SAME transaction as the password write", () => {
    // A credential change recorded only sometimes is worse than one never
    // recorded, because the gaps read as "nothing happened here".
    for (const fn of ["confirmPasswordReset", "acceptInvite"]) {
      const body = bodyOf(fn);
      expect(body.indexOf("passwordHash, passwordChangedAt")).toBeLessThan(body.indexOf("auditCredentialEvent"));
      expect(body).toMatch(/auditCredentialEvent\([\s\S]{0,120}tx\)/);
    }
  });

  it("attributes the row to the user themselves, in their own school", () => {
    const helper = SRC.slice(SRC.indexOf("private async auditCredentialEvent"));
    expect(helper.slice(0, 600)).toMatch(
      /this\.audit\.record\(\{ actorId: userId, action, entity: "user", entityId: userId, schoolId \}, tx\)/,
    );
  });

  it("records NOTHING that came from the caller", () => {
    // No token, no password, no submitted address — an audit row must not become
    // a place attacker-supplied text is stored and later read back. The action
    // strings themselves name passwords, so this checks the RECORD CALL: it
    // carries no metadata bag and interpolates nothing.
    const at = SRC.indexOf("await this.audit.record(", SRC.indexOf("private async auditCredentialEvent"));
    const call = SRC.slice(at, SRC.indexOf(";", at));
    expect(call).not.toMatch(/metadata/);
    expect(call).not.toMatch(/[`$]/);
    // Its parameters are the only inputs: two ids, a fixed action, and the tx.
    const sig = SRC.slice(
      SRC.indexOf("private async auditCredentialEvent"),
      SRC.indexOf("): Promise<void>", SRC.indexOf("private async auditCredentialEvent")),
    );
    expect(sig).not.toMatch(/token|password:|email/i);
  });

  it("only for an account that exists", () => {
    // An unknown address has no actor to attribute, and the request path stays
    // constant-time by design — see the timing-oracle comment it sits inside.
    const body = bodyOf("deliverPasswordReset");
    expect(body.indexOf('if (!user || user.status !== "ACTIVE") return;')).toBeLessThan(
      body.indexOf("auditCredentialEvent"),
    );
  });
});

describe("the events the platform already had", () => {
  it("still records the in-app change", () => {
    // This fix adds to that one; it does not move it.
    const auth = readFileSync(join(__dirname, "../../src/foundation/auth.service.ts"), "utf8");
    expect(auth).toMatch(/action: "auth\.password\.changed"/);
  });

  it("still records login, failure and lockout", () => {
    const auth = readFileSync(join(__dirname, "../../src/foundation/auth.service.ts"), "utf8");
    expect(auth).toMatch(/action: "auth\.login"/);
    expect(auth).toMatch(/auth\.account\.locked/);
    expect(auth).toMatch(/auth\.login\.failed/);
  });
});
