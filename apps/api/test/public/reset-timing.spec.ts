// =============================================================================
// "Does this address have an account here?" must not be answerable
// =============================================================================
// The forgot-password response was already constant — always {ok:true}, every
// error swallowed — so there was no oracle in what it SAID. There was one in how
// long it took to say it. A known address cost two extra queries, a JWT sign and
// an AWAITED email send; an unknown one returned after a single lookup.
//
// Measured against the running stack with the mail provider STUBBED, so with no
// network call at all:
//
//   admin@demo.school                       0.06s
//   definitely-not-a-user-xyz@nowhere.test  0.01s
//
// Six times, on the cheap path. A real provider makes it hundreds of
// milliseconds. Anybody can ask the question and read the answer off a
// stopwatch, and a confirmed address is what makes a phishing mail credible.
//
// The fix is not to pad the fast path — that is fragile and slows everyone down.
// It is to take the work off the response path entirely, so the answer is
// returned before the two cases diverge at all.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/public/public.service.ts"), "utf8");
// Just the PUBLIC method — the detached worker now sits between it and
// confirmPasswordReset, and its returns are not part of the response contract.
const REQUEST = SRC.slice(
  SRC.indexOf("async requestPasswordReset"),
  SRC.indexOf("private async deliverPasswordReset"),
);

describe("the forgot-password request", () => {
  it("returns without awaiting the lookup or the email", () => {
    // `void` the detached promise, then return. If this is ever awaited again
    // the timing gap comes straight back.
    expect(REQUEST).toMatch(/void this\.deliverPasswordReset\(email\);\s*\n\s*return \{ ok: true \}/);
  });

  it("does the work in a method that cannot reject into the caller", () => {
    // A detached promise that throws is an unhandled rejection, which in some
    // Node configurations takes the process down — a far worse outcome than the
    // oracle. The work keeps the try/catch it always had.
    const deliver = SRC.slice(SRC.indexOf("private async deliverPasswordReset"));
    expect(deliver).toMatch(/try \{/);
    expect(deliver).toMatch(/catch \(err\)/);
    expect(deliver).toMatch(/logger\.warn/);
  });

  it("still answers the same thing either way", () => {
    // The body must stay constant: an unknown address and a known one both get
    // {ok:true}, and no branch may return anything else.
    // Comments stripped first: prose about what the code "returned" is not a
    // return statement, and a guard that trips on its own explanation gets
    // weakened until it guards nothing.
    const code = REQUEST.replace(/^\s*\/\/.*$/gm, "");
    const returns = [...code.matchAll(/\breturn\b[^;]*;/g)].map((m) => m[0].trim());
    expect(returns).toEqual(["return { ok: true };"]);
  });

  it("keeps the reset link short-lived and single-use", () => {
    // Unchanged by this fix, and worth pinning next to it: the token carries the
    // password's current change-timestamp, so the moment a reset lands every
    // previously-issued link for that account is dead.
    const invite = readFileSync(join(__dirname, "../../src/auth/invite.ts"), "utf8");
    expect(invite).toMatch(/RESET_TTL = "30m"/);
    expect(invite).toMatch(/pca: passwordChangedAt\?\.getTime\(\) \?\? 0/);
    const confirm = SRC.slice(SRC.indexOf("async confirmPasswordReset"));
    expect(confirm).toMatch(/\(user\.passwordChangedAt\?\.getTime\(\) \?\? 0\) !== reset\.pca/);
  });

  it("refuses a reset for somebody who has left", () => {
    // Consistent with the exits work: status is what auth checks, and a reset
    // must not be a way back in for a departed account.
    const confirm = SRC.slice(SRC.indexOf("async confirmPasswordReset"));
    expect(confirm).toMatch(/user\.status !== "ACTIVE"/);
  });
});
