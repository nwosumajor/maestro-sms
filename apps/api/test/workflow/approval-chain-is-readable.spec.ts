// =============================================================================
// The approval chain existed and nothing could read it
// =============================================================================
// Audited the workflow engine — the backbone of every maker-checker in the
// product: leave, salary changes, fee runs, admin appointments, grade
// publishing, attendance amendments, student exits. The ENFORCEMENT is sound,
// and the checks below record which parts, so they are not re-derived:
//
//   - the actor must hold THIS stage's granular permission, not merely
//     `workflow.review`;
//   - they must not have acted on the request before, so no one person can
//     decide two stages;
//   - a routed stage is gated to its named approver, with a self-healing
//     fallback when that person has left (found live, deadlocking the chain);
//   - `mustNotBeInitiator` keeps a requester off their own request.
//
// What was missing was a READER. `GET /workflows/:id` returned the approvals
// and the immutable trail, and NO PAGE CALLED IT — the admin dashboard fetches
// `GET /workflows` (the list) and nothing else. So a school could see that a
// salary change was pending and act on it, but could never afterwards see who
// approved which stage or when. A maker-checker record that cannot be read is
// most of the way to not having one.
//
// The field this is really about is `viaElevation`. Stage permissions ARE
// elevatable — deliberately, since elevation is itself maker-checker and
// break-glass is flagged — and the engine records on each approval whether the
// approver's authority came from a grant rather than their role. The comment
// where it is written says "the trail should show that a stand-in decided it,
// not merely who". It was written into a JSON column that nothing read, so a
// stage decided by a stand-in looked exactly like one decided by the person who
// holds that authority every day.
//
// // The surface gate did not catch this: its note claimed the route was
// reached from app/(app)/admin/page.tsx. That page calls the LIST. A gate is
// only as good as its notes, and this one was wrong.
// =============================================================================

import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";

const SRC = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");
const strip = (s: string) => stripComments(s);
const SERVICE = SRC("workflow/workflow.service.ts");
const CODE = strip(SERVICE);

describe("what the engine enforces, and still does", () => {
  it("checks THIS stage's granular permission, not a blanket one", () => {
    expect(CODE).toMatch(/!p\.permissions\.includes\(stage\.permission\)/);
  });

  it("stops one person deciding two stages of the same request", () => {
    expect(CODE).toMatch(/approvals\.some\(\(a\) => a\.approverId === p\.userId\)/);
  });

  it("keeps a requester off their own request", () => {
    expect(CODE).toMatch(/mustNotBeInitiator && req\.initiatorId === p\.userId/);
  });

  it("gates a routed stage to its named approver", () => {
    expect(CODE).toMatch(/named && named !== p\.userId/);
  });

  it("still self-heals when that approver has left", () => {
    // Otherwise the request is stuck forever and silently — confirmed live
    // before it was fixed.
    expect(CODE).toMatch(/stillHere/);
  });
});

describe("the chain can now be read", () => {
  it("returns every stage, decided or not", () => {
    expect(CODE).toMatch(/stages: stages\.map/);
    expect(CODE).toMatch(/decidedBy: decided/);
  });

  it("surfaces viaElevation instead of leaving it in a JSON column", () => {
    expect(CODE).toMatch(/viaElevation: decided\.viaElevation === true/);
  });

  it("resolves names in ONE lookup, not one per approval", () => {
    expect(CODE).toMatch(/where: \{ id: \{ in: ids \} \}/);
  });

  it("still refuses anyone but a reviewer or the initiator, with a 404", () => {
    const at = CODE.indexOf("async getRequest");
    const body = CODE.slice(at, at + 900);
    expect(body).toMatch(/!this\.isReviewer\(p\) && req\.initiatorId !== p\.userId/);
    expect(body).toMatch(/NotFoundException\("Request not found"\)/);
  });

  it("never returns the raw payload — only a service-written summary", () => {
    const at = CODE.indexOf("async getRequest");
    const body = CODE.slice(at, at + 3000);
    expect(body).toMatch(/summary:/);
    expect(body).not.toMatch(/payload: req\.payload/);
  });
});

describe("the immutable trail records it too", () => {
  it("notes an elevated decision in the audit comment", () => {
    // The detail view can be changed; the WorkflowAuditLog row cannot.
    expect(CODE).toMatch(/decided under a temporary elevation grant/);
  });
});

describe("the reader itself", () => {
  const WEB = readFileSync(
    join(__dirname, "../../../web/components/workflow/WorkflowChain.tsx"),
    "utf8",
  );

  it("shows the elevation badge", () => {
    expect(WEB).toMatch(/under temporary elevation/);
  });

  it("does not turn a failed read into an empty chain", () => {
    // "No approvals" about a request that has them is worse than saying nothing.
    expect(WEB).toMatch(/setFailed\(true\)/);
    expect(WEB).toMatch(/Couldn&rsquo;t load the approval history/);
  });

  it("is reachable from the approvals inbox", () => {
    const inbox = readFileSync(
      join(__dirname, "../../../web/components/workflow/WorkflowInbox.tsx"),
      "utf8",
    );
    expect(inbox).toMatch(/<WorkflowChain requestId=\{w\.id\} \/>/);
  });
});
