// =============================================================================
// An alumni broadcast that reached nobody and said it had
// =============================================================================
// Found by driving a path that had never executed: `alumnus` had no rows.
//
// `queued` counted alumni with a LINKED ACCOUNT and `unreachable` counted those
// without one. But `NotificationService.persist` drops every EXTERNAL channel
// for a recipient whose status is not ACTIVE — and an alumnus has LEFT by
// definition, so their account is exactly that. They cannot sign in to read the
// in-app copy either.
//
// Measured live, one alumna linked to a departed pupil:
//
//   before   {"queued":1,"unreachable":0}   1 in-app row, 0 email deliveries
//   after    {"queued":0,"unreachable":1,"closedAccounts":1}   nothing written
//
// The field that exists to report who was NOT reached counted the wrong
// population — and the larger one, since an account is closed for every alumnus
// the school ever exited properly.
//
// // THE UI HAD ALREADY BEEN THROUGH THE FIRST LAYER of this: "This used to say
// 'it goes out to the alumni body' ... A school with fifty on file and three
// linked accounts was told it had gone out." The second layer is the majority
// case, and was left.
//
// // NOT FIXED, and it is a DECISION rather than a defect: the alumni module
// exists to contact people who have left, and the notification funnel refuses to
// contact people who have left. Only `deliverableEmail()` (a real
// `contactEmail`) is ever used as a target, so the mail COULD go out — whether
// alumni are exempt from the departed-recipient rule is a question about mailing
// former pupils, not a bug to fix quietly. Until it is answered, the count tells
// the truth instead of claiming a delivery.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SVC = readFileSync(join(__dirname, "../../src/alumni/alumni.service.ts"), "utf8");
const UI = readFileSync(join(__dirname, "../../../web/components/alumni/AlumniManager.tsx"), "utf8");

describe("an alumni broadcast reports what it reached", () => {
  it("counts a linked account only when it can actually be written to", () => {
    // `userId: { not: null }` is still counted — that is the LINKED total, and
    // it is fine. What was missing is the second question: of those, how many
    // accounts are still open. Asked as a raw join because the schema has no
    // Prisma relation here and the register is too big to hydrate.
    const stripped = SVC.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).toMatch(/JOIN "user" u ON u\.id = a\."userId"/);
    expect(stripped).toMatch(/u\.status = 'ACTIVE'/);
  });

  it("separates the two reasons somebody cannot be reached", () => {
    // "No account — add one" and "the account is closed" need different
    // actions, so one number for both is not an answer.
    expect(SVC).toMatch(/closedAccounts/);
    // Matched on the LITERAL text either side of the ternary, not on a phrase
    // the ternary splits — the first version asserted "has no account" and the
    // source reads `${n === 1 ? "has" : "have"} no account`, so a correct UI
    // failed. A brittle pattern is a false negative waiting to happen.
    expect(UI).toMatch(/no account — add one to reach them/);
    expect(UI).toMatch(/closed account/);
    expect(UI).toMatch(/cannot be written to at all/);
  });

  it("the fan-out agrees with the count", () => {
    // A count that says 0 while the fan-out writes N is the same lie in
    // reverse, and it would put a message in an inbox nobody can open.
    const fan = SVC.slice(SVC.indexOf("async fanOutBroadcast"));
    expect(fan).toMatch(/status: "ACTIVE"/);
  });
});
