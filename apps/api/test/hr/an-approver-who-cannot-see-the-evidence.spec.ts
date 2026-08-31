/**
 * A SICK NOTE NOBODY COULD SEE.
 *
 * `leave_request.attachmentDocId` has been accepted, validated and returned in
 * the DTO since the leave module shipped, and NO screen read it. So a document
 * supplied through the API was invisible to everyone — including the approver,
 * who is the person it exists for.
 *
 * Worse, the workflow inbox renders ONE field from the payload, `summary`, and
 * nothing else. So even an approver looking straight at the request had no way
 * to know evidence was attached.
 *
 * WHAT IS NOT FIXED HERE, AND WHY. Attaching one from the leave form cannot
 * work for most of the people who take leave: the API requires a Vault document
 * the CALLER uploaded, and `createDocument` refuses a non-student document from
 * anyone who is not school-wide. So teacher, hr_clerk, warden and librarian —
 * who all hold `hr.self` — cannot produce one at all. That is a decision about
 * where a member of staff's own sick note lives and who may read it, not a form
 * field, so the backlog entry now says so instead of calling it a missing
 * screen. Building the form first is what found it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = readFileSync(join(__dirname, "..", "..", "src", "hr", "leave.service.ts"), "utf8");
const SELF = readFileSync(
  join(__dirname, "..", "..", "..", "web", "components", "hr", "LeaveSelfService.tsx"),
  "utf8",
);

describe("the approver is told evidence exists", () => {
  it("the summary says so, because the inbox renders nothing else", () => {
    expect(SERVICE).toMatch(/a supporting document is attached/);
  });

  it("only when there IS one — a line on every request is one nobody reads", () => {
    expect(SERVICE).toMatch(/input\.attachmentDocId \? " · a supporting document is attached/);
  });

  it("points at the page that can show it, since a payload is a string", () => {
    // The summary cannot carry a link, so it names where to look rather than
    // implying the inbox will render one.
    expect(SERVICE).toMatch(/see the leave page/);
  });
});

describe("and the leave page shows it", () => {
  it("links to the attachment when the request carries one", () => {
    expect(SELF).toMatch(/\{r\.attachmentDocId && \(/);
  });

  it("streams it through the API, not a bucket URL", () => {
    // `/file` works with the local stub and with S3 alike; the browser never
    // needs bucket credentials. `/download` is not a route — that was the first
    // guess here and it would have 404'd.
    expect(SELF).toMatch(/documents\/\$\{r\.attachmentDocId\}\/file/);
    expect(SELF).not.toMatch(/attachmentDocId\}\/download/);
  });
});
