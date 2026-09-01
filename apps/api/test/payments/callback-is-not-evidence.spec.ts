// =============================================================================
// A forged callback marked an invoice paid
// =============================================================================
// Audited the public surface — every route reachable without a session. It is
// in good shape: all four public writes on the public controller are
// rate-limited (password-reset/request tightest at 5/min), admissions and
// careers likewise, and the only UNLIMITED public writes are machine callbacks
// — Paystack, Stripe, Twilio, biometric ingestion and mobile money — where a
// limiter would drop real payments and where every one of them either verifies
// a signature or, now, verifies with the rail.
//
// That last clause is this fix. M-Pesa and MTN sign NOTHING, and the service
// already reasons carefully that AMOUNTS must come from the intent we wrote
// rather than from the callback body. The OUTCOME is a statement of fact too,
// and it was taken on trust:
//
//     const reading = provider.readCallback(body);
//     ...
//     await this.applyReading(intent, reading, body);   // reading.outcome === "SUCCEEDED"
//
// And the payer knows their own reference — `charge()` RETURNS it to them:
//
//     return { reference: intent.reference, provider, status: "PENDING", instruction }
//
// So a parent could start a charge, DECLINE the prompt on their phone, and POST
// a success-shaped body to this public endpoint carrying that reference. The
// invoice settled for the full amount with no money moved. Nothing corrects it
// afterwards: `applyReading` returns early once the intent is not PENDING, so
// the recovery sweep never looks again, and settlement is idempotent on the
// reference.
//
// The fix reuses machinery that already existed: every adapter implements
// `getStatus` for the recovery sweep, so the callback is demoted to a doorbell
// and the rail is ASKED. A forged body now buys an attacker one outbound query.
// =============================================================================

import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/payments/mobile-money.service.ts"), "utf8");
const CODE = stripComments(SRC);

function bodyOf(name: string): string {
  const m = new RegExp(`async ${name}\\s*\\(`).exec(CODE);
  if (!m) throw new Error(`no ${name}`);
  const open = CODE.indexOf("{\n", m.index);
  let d = 0;
  for (let i = open; i < CODE.length; i++) {
    if (CODE[i] === "{") d++;
    else if (CODE[i] === "}" && --d === 0) return CODE.slice(open, i);
  }
  throw new Error("unterminated");
}

const CALLBACK = bodyOf("handleCallback");

describe("what a callback is allowed to decide", () => {
  it("asks the rail before acting on the outcome", () => {
    expect(CALLBACK).toMatch(/provider\.getStatus\(\{ reference: intent\.reference/);
  });

  it("settles on the RAIL's verdict, not the body's", () => {
    expect(CALLBACK).toMatch(/applyReading\(intent, verified, body\)/);
    expect(CALLBACK).not.toMatch(/applyReading\(intent, reading, body\)/);
  });

  it("verifies BEFORE applying, not after", () => {
    expect(CALLBACK.indexOf("getStatus")).toBeLessThan(CALLBACK.indexOf("applyReading"));
  });

  it("leaves the intent PENDING when the rail cannot be reached", () => {
    // Settling or failing on an unverified claim is the whole thing being
    // prevented; the sweep will ask again.
    expect(CALLBACK).toMatch(/catch \(err\)[\s\S]{0,400}?return \{ ok: true \}/);
  });

  it("still answers 2xx on every path", () => {
    // A non-2xx makes a rail retry forever — the reason this endpoint swallows
    // everything.
    const returns = CALLBACK.match(/return \{ ok: true \}/g) ?? [];
    expect(returns.length).toBeGreaterThanOrEqual(4);
  });

  it("notices when the rail disagrees with the body", () => {
    // Either a rail that changed its mind, or somebody posting a claim it does
    // not support. Both are worth a line.
    expect(CALLBACK).toMatch(/claimed \$\{reading\.outcome\}, rail says/);
  });
});

describe("what the fix must not have undone", () => {
  it("still records the CALLBACK's payload in gateway_event", () => {
    // That table answers "what did a rail tell us, and when" — replacing the
    // payload with our own query result would lose the original claim.
    expect(CALLBACK).toMatch(/applyReading\(intent, verified, body\)/);
  });

  it("still takes the amount from the intent, never the body", () => {
    const apply = bodyOf("applyReading");
    expect(apply).toMatch(/creditMinor: intent\.amountMinor/);
    expect(apply).toMatch(/currency: intent\.currency/);
  });

  it("still ignores a rail that re-notifies a settled charge", () => {
    expect(bodyOf("applyReading")).toMatch(/if \(intent\.status !== "PENDING"\) return/);
  });

  it("still treats PENDING as 'we do not know'", () => {
    expect(bodyOf("applyReading")).toMatch(/outcome === "PENDING"\) return/);
  });

  it("leaves the recovery sweep's path unchanged — it already asked the rail", () => {
    expect(CODE).toMatch(/reading = await provider\.getStatus\(\{ reference: intent\.reference/);
  });
});
