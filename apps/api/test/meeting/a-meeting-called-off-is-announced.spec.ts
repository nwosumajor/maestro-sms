/**
 * Creating a meeting slot ANNOUNCES it to the whole audience — a class, a
 * stream, a stage, or every guardian in the school. Withdrawing it announced
 * NOTHING.
 *
 * Measured on the running stack: a class meeting told the parents "A meeting
 * has been called — All History 101 parents, 2026-09-09 at Room 4"; the host
 * withdrew it and ZERO notices followed. The families still held the notice for
 * a meeting that was no longer taking place, and on a whole-school audience
 * that is every guardian in the school.
 *
 * The same class this codebase already records four times: a withdrawn cover
 * duty, a retracted bus boarding, a corrected absence and a cancelled invoice.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "../support/strip-comments";
import { NOTIFICATION_MESSAGES } from "@sms/types";

const SRC = stripComments(readFileSync(path.join(__dirname, "../../src/meeting/meeting.service.ts"), "utf8"));

const withdrawBody = (() => {
  const at = SRC.indexOf("async withdrawSlot(");
  const next = SRC.indexOf("\n  /**", at);
  return SRC.slice(at, next > at ? next : at + 4000);
})();

describe("a meeting that is called off is announced", () => {
  it("announces the withdrawal to the same audience", () => {
    expect(withdrawBody).toMatch(/this\.announce\(/);
    expect(withdrawBody).toMatch(/"withdrawn"/);
  });

  // RETRACT ONLY WHAT WAS SENT. `announce` fires on create for every declared
  // audience EXCEPT a single-pupil appointment, which is a private offer nobody
  // was told about — a retraction for one would be the first its recipient
  // heard of any of it.
  it("stays silent for the one audience that was never announced", () => {
    expect(withdrawBody).toMatch(/slot\.audienceKind !== "STUDENT"/);
    // The same condition guards the create-side announce, so the pair cannot
    // drift into retracting something nobody was told.
    expect(SRC).toMatch(/declared && declared\.kind !== "STUDENT"/);
  });

  // OUTSIDE the transaction, for the reason `announce` already runs outside one
  // on create: a whole-school audience is thousands of notification rows, and
  // an interactive transaction is capped at 5 seconds.
  it("notifies outside the withdrawal's transaction", () => {
    const txEnd = withdrawBody.indexOf("return { slot };");
    expect(txEnd).toBeGreaterThan(-1);
    expect(withdrawBody.indexOf("this.announce(")).toBeGreaterThan(txEnd);
  });

  it("reports how many were told, rather than only that it withdrew", () => {
    expect(withdrawBody).toMatch(/return \{ withdrawn: true, told \}/);
  });

  // ONE ANNOUNCER, two messages. A second copy is how a pair drifts — the
  // argument this codebase already made for `meetingWhen`.
  it("shares one announcer with the create-side notice", () => {
    const calls = SRC.match(/private async announce\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const ann = SRC.slice(SRC.indexOf("private async announce("));
    const body = ann.slice(0, ann.indexOf("\n  private "));
    expect(body).toMatch(/kind === "called" \? "meeting\.called" : "meeting\.withdrawn"/);
    // Both readings resolve the SAME audience and use the SAME chunking.
    expect(body).toMatch(/resolveAudience\(/);
    expect(body).toMatch(/ANNOUNCE_CHUNK/);
  });

  // A failed notice must not undo a withdrawal that has already committed.
  it("swallows a failed announcement rather than losing the withdrawal", () => {
    const ann = SRC.slice(SRC.indexOf("private async announce("));
    const body = ann.slice(0, ann.indexOf("\n  private "));
    expect(body).toMatch(/catch \(err\)[\s\S]{0,400}return 0;/);
  });
});

describe("the message a family reads", () => {
  it("exists, and in the same languages as the announcement it retracts", () => {
    const called = NOTIFICATION_MESSAGES["meeting.called"];
    const withdrawn = NOTIFICATION_MESSAGES["meeting.withdrawn"];
    expect(withdrawn).toBeDefined();
    // NOTE: `MessageTemplate` types both maps as Record<MessageLanguage, …>,
    // so a MISSING language does not compile — the compiler owns that half and
    // a mutation dropping `fr` failed to build rather than failing this test.
    // What is left for a test is the pair staying in step as the catalogue
    // grows: a language added to the announcement and not to its retraction
    // would reach a family in the wrong one, on the notice telling them not to
    // come.
    expect(Object.keys(withdrawn.title).sort()).toEqual(Object.keys(called.title).sort());
    expect(Object.keys(withdrawn.body).sort()).toEqual(Object.keys(called.body).sort());
  });

  it("says nothing is needed from the reader, so it is not mistaken for a new meeting", () => {
    expect(NOTIFICATION_MESSAGES["meeting.withdrawn"].body.en).toMatch(/no longer taking place/);
    expect(NOTIFICATION_MESSAGES["meeting.withdrawn"].body.en).toMatch(/Nothing is needed/);
  });

  // The date has to be in the SCHOOL's clock, like the announcement it
  // retracts — a family comparing the two must not see two different times.
  it("renders the date on the school's own clock", () => {
    const ann = SRC.slice(SRC.indexOf("private async announce("));
    const body = ann.slice(0, ann.indexOf("\n  private "));
    expect(body).toMatch(/schoolTimeString\(await this\.timezoneOf\(p\), slot\.startsAt\)/);
  });
});
