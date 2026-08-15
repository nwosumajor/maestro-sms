// =============================================================================
// The anonymous survey, deanonymised by the screen next door
// =============================================================================
// Two mechanisms, each correct on its own, that cancelled each other out:
//
//   * a form marked ANONYMOUS never returns the respondent — `responses()`
//     builds an explicit DTO and sets `respondentName: null`;
//   * every mutation is audited with its actor (Golden Rule).
//
// So responding to an anonymous form wrote "this user responded to this form" to
// the audit log, which a principal or school_admin reads at /admin/audit with
// names already resolved. Live, both as the same principal:
//
//   form screen : {"respondentName":null,"answers":{"q1":"No — I am being bullied"},
//                  "createdAt":"2026-08-15T12:21:47.596Z"}
//   audit screen: {"action":"form.respond","actorName":"Demo Student",
//                  "createdAt":"2026-08-15T12:21:47.600Z"}
//
// Four milliseconds apart. And because BOTH sides are timestamped — the audit row
// and the answer — this does not merely reveal who took part: it attributes each
// answer to a named pupil. That is a school's bullying survey, or its staff
// survey about leadership, read by exactly the people the anonymity exists to
// hold at arm's length.
//
// The event is still recorded — a response arrived, on this form, at this time —
// under the SYSTEM actor. Not hidden from the viewer but ABSENT from the row, so
// a backup, a restore drill or a support query cannot reconstruct it either.
//
// Polls have the same shape and are anonymous by construction, so a vote is
// audited the same way. It leaked less (the chosen option was never in the row)
// but a participation roll for a poll about leadership, readable by leadership,
// is not an anonymous poll — and in a small cohort, participation plus the tally
// can be enough on its own.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FORM = readFileSync(join(__dirname, "../../src/form/form.service.ts"), "utf8");
const POLL = readFileSync(join(__dirname, "../../src/poll/poll.service.ts"), "utf8");
const bodyOf = (src: string, name: string): string => {
  const at = src.indexOf(`async ${name}(`);
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, at + 2600);
};

describe("responding to an anonymous form", () => {
  it("audits under the SYSTEM actor, not the respondent", async () => {
    expect(bodyOf(FORM, "respond")).toMatch(
      /this\.logAs\(tx, form\.anonymous \? SYSTEM_ACTOR_ID : p\.userId, p\.schoolId, "form\.respond", formId/,
    );
  });

  it("still records that a response arrived", () => {
    // Removing the audit entirely would trade one fault for another: nobody
    // could then tell whether the form was working at all.
    expect(bodyOf(FORM, "respond")).toMatch(/"form\.respond"/);
  });

  it("keeps the real actor for a NON-anonymous form", () => {
    // The rule is about anonymity, not about auditing less. A named form is
    // still attributable.
    const respond = bodyOf(FORM, "respond");
    expect(respond).toMatch(/form\.anonymous \? SYSTEM_ACTOR_ID : p\.userId/);
  });

  it("the actor is the ONLY thing withheld — the form and time remain", () => {
    expect(bodyOf(FORM, "respond")).toMatch(/"form\.respond", formId/);
  });
});

describe("voting in a poll", () => {
  it("audits under the SYSTEM actor", () => {
    expect(bodyOf(POLL, "vote")).toMatch(/this\.logAs\(tx, SYSTEM_ACTOR_ID, p\.schoolId, "poll\.vote", pollId, \{\}\)/);
  });

  it("still never records which option was chosen", () => {
    // The property that already held. Narrowing the actor must not widen this.
    const vote = bodyOf(POLL, "vote");
    expect(vote).not.toMatch(/"poll\.vote",[^)]*optionId/);
  });
});

describe("what stays attributable", () => {
  it("creating and closing a form name the staff member who did it", () => {
    // These are staff actions on the form itself, not participation in it.
    expect(bodyOf(FORM, "createForm")).toMatch(/this\.log\(tx, p, "form\.create"/);
    expect(bodyOf(FORM, "closeForm")).toMatch(/this\.log\(tx, p, "form\.close"/);
  });

  it("creating and closing a poll do too", () => {
    expect(bodyOf(POLL, "createPoll")).toMatch(/this\.log\(tx, p, "poll\.create"/);
    expect(bodyOf(POLL, "closePoll")).toMatch(/this\.log\(tx, p, "poll\.close"/);
  });

  it("reading responses is still audited against the staff reader", () => {
    // Who LOOKED at the answers is exactly the thing to keep recording.
    expect(bodyOf(FORM, "responses")).toMatch(/this\.log\(tx, p, "form\.responses\.read"/);
  });
});

describe("the anonymity that was already right", () => {
  it("responses never carry the respondent id, anonymous or not", () => {
    // The DTO is an allow-list: id, name (null when anonymous), answers, time.
    const responses = bodyOf(FORM, "responses");
    expect(responses).toMatch(/respondentName: form\.anonymous \? null :/);
    expect(responses).not.toMatch(/respondentId: r\.respondentId/);
  });

  it("the header no longer claims the audit records participation", () => {
    // The comment said the vote was stored "to audit participation". It was
    // describing the bug.
    expect(POLL).not.toMatch(/and to audit participation;/);
  });
});
