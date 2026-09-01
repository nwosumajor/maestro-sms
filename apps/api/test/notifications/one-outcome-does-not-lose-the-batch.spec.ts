// =============================================================================
// One row lost the truth about five hundred delivered messages
// =============================================================================
// Generalised #263's lesson — that the blast radius of a per-item failure is
// decided by the TRANSACTION SPAN — by sweeping for loops that write per item
// inside one `runAsTenant`. Twenty came back. Most SHOULD be all-or-nothing: a
// payroll run, a promotion batch, a bulk enrolment are single decisions and a
// half-applied one is worse than none.
//
// The notification fan-out is not one of those, and it has two loops that must
// be read differently:
//
//   PLANNING (line ~344) — stamps each delivery's attempt and resolves targets
//     BEFORE any gateway is called. Nothing has been sent, so rolling the whole
//     thing back is correct. Left alone.
//
//   RECORDING — runs AFTER every gateway call has already happened, and only
//     writes down what they said. One transaction wrapped the whole loop, so a
//     single failure rolled back every OTHER outcome: a fan-out of five hundred
//     guardian alerts, all genuinely delivered, recorded as nothing.
//
// What makes that bite is the recovery sweep's rule, which is itself correct: a
// row PENDING *with an attempt stamped* was handed to a gateway and its outcome
// was lost, so it must NOT be re-sent. So the school is told five hundred
// messages failed when every one arrived, and no credit is spent for any.
//
// And it is not thin plumbing that could hardly fail: `debitInTx` writes a
// ledger row and then `warnIfLow` READS staff and ENQUEUES a low-balance
// notification. The loop does considerably more than one update per item.
// =============================================================================

import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/notifications/notification.service.ts"), "utf8");
const strip = (s: string) => stripComments(s);

/** The recording block: from the "Record what happened" marker to the return. */
const RECORDING = strip(
  SRC.slice(SRC.indexOf("Record what happened"), SRC.indexOf("return { sent, failed }")),
);

describe("recording what the gateways said", () => {
  it("gives each outcome its own transaction", () => {
    // It is an independent fact about a different message, not part of one
    // decision.
    expect(RECORDING).toMatch(/for \(const o of outcomes\)[\s\S]{0,200}?runAsTenant/);
  });

  it("keeps the debit and the status together inside it", () => {
    // A credit must never be spent on a message we did not manage to mark sent.
    const tx = RECORDING.slice(RECORDING.indexOf("runAsTenant"));
    expect(tx.indexOf("debitInTx")).toBeGreaterThan(-1);
    expect(tx.indexOf("debitInTx")).toBeLessThan(tx.indexOf("notificationDelivery.update"));
  });

  it("carries on when one outcome cannot be written", () => {
    expect(RECORDING).toMatch(/catch \(e\)/);
  });

  it("counts an outcome only once it is actually recorded", () => {
    // Incrementing before the write would report sends the ledger never got.
    const commit = RECORDING.indexOf("});");
    expect(RECORDING.indexOf("o.result.ok ? sent++ : failed++")).toBeGreaterThan(commit);
  });

  it("is LOUD about a send it could not write down", () => {
    // The message went out and the record did not. That is not a debug line.
    expect(RECORDING).toMatch(/logger\.error\(/);
    expect(SRC).toMatch(/was sent on \$\{o\.channel\} but its outcome could not be recorded/);
  });
});

describe("the planning loop, deliberately untouched", () => {
  const PLANNING = strip(SRC.slice(SRC.indexOf("const attempts"), SRC.indexOf("Record what happened")));

  it("still stamps the attempt before any gateway is told anything", () => {
    // This is what makes a PENDING row afterwards mean something.
    expect(PLANNING).toMatch(/attempts: \{ increment: 1 \}/);
  });

  it("stays inside ONE transaction, because nothing has been sent yet", () => {
    // Rolling back a plan is free; rolling back a record is a lie.
    expect(PLANNING).not.toMatch(/catch \(e\)[\s\S]{0,120}?logger\.error/);
  });
});
