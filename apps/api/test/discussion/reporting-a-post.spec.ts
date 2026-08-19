// =============================================================================
// Moderation existed; discovery did not
// =============================================================================
// A moderator could remove any post. Nothing let a reader say "look at this" —
// so in a school with hundreds of pupils posting to audience-wide groups,
// harmful content came down only if a member of staff happened to be reading the
// thread. That is not moderation, it is chance, and the person who sees it first
// is almost always a child with no way to act.
//
// A report is a DISCIPLINE COMPLAINT rather than a new parallel pipeline: it is
// a record that somebody objects to another person's conduct, which that module
// already models, reviews, assigns and resolves — and a forum report inherits
// its staff review, its "never visible to the person it is about" rule, and its
// human-only outcome.
//
// Three properties this must not break:
//
//   the reporter never NAMES anybody. They name a post, and the server resolves
//   the author from a row it has already checked they may see. The ordinary
//   filing path requires the target to be on the filer's roster precisely to stop
//   an id being guessed; here there is no id to guess, which is why reporting can
//   reach a pupil in another class — the case that matters most.
//
//   reporting does NOT hide the post (Golden Rule #8). If it did, any pupil could
//   silence any other by objecting to them.
//
//   a repeat report is idempotent, or a pupil could bury the real cases under
//   their own duplicates.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DiscussionService } from "../../src/discussion/discussion.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const PUPIL: Principal = { schoolId: "A", userId: "pupil-1", roles: ["student"], permissions: ["discussion.participate"] };
const AUTHOR = "pupil-2";

function make(over: { audience?: string; post?: unknown; comment?: unknown; authorRoles?: string[] } = {}) {
  const file = jest.fn().mockResolvedValue({ id: "case-1", alreadyOpen: false });
  const del = jest.fn();
  const tx = {
    discussionPost: {
      findFirst: jest.fn().mockResolvedValue(
        "post" in over ? over.post : { id: "post-1", groupId: "g1", authorId: AUTHOR },
      ),
      update: del,
    },
    discussionGroup: {
      findFirst: jest.fn().mockResolvedValue({ id: "g1", name: "Year 9 Notice Board", audience: over.audience ?? "STUDENTS" }),
    },
    discussionComment: {
      findFirst: jest.fn().mockResolvedValue("comment" in over ? over.comment : { id: "cm-1", authorId: "pupil-3" }),
      update: del,
    },
    userRole: {
      findMany: jest.fn().mockResolvedValue((over.authorRoles ?? ["student"]).map((n) => ({ role: { name: n } }))),
    },
  } as unknown as TenantTx;
  const s = Object.create(DiscussionService.prototype) as DiscussionService;
  Object.assign(s, {
    db: {
      runAsTenant: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)),
      runAsTenantReadOnly: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)),
    },
    audit: { record: jest.fn() },
    discipline: { fileAboutVisibleContent: file },
  });
  (s as unknown as { log: unknown }).log = jest.fn();
  return { s, tx, file, del };
}

describe("reporting a post", () => {
  it("files a discipline case against the post's author", async () => {
    const { s, file } = make();
    await expect(s.reportPost(PUPIL, "post-1", "This is abusive")).resolves.toEqual({
      complaintId: "case-1",
      alreadyReported: false,
    });
    expect(file).toHaveBeenCalledWith(
      PUPIL,
      expect.objectContaining({ againstId: AUTHOR, againstType: "STUDENT" }),
    );
  });

  it("resolves the author on the SERVER — the reporter never supplies one", async () => {
    // The whole reason this can reach a pupil in another class: nothing about
    // the target comes from the request, so there is nothing to guess.
    const { s, file } = make();
    await s.reportPost(PUPIL, "post-1", "abusive");
    const arg = file.mock.calls[0][1] as { againstId: string; details: string };
    expect(arg.againstId).toBe(AUTHOR);
    expect(arg.details).toContain("post-1");
    expect(arg.details).toContain("Year 9 Notice Board");
  });

  it("carries the reporter's own words to the reviewer", async () => {
    const { s, file } = make();
    await s.reportPost(PUPIL, "post-1", "He keeps saying things about my sister");
    expect((file.mock.calls[0][1] as { details: string }).details).toContain("He keeps saying things about my sister");
  });

  it("does NOT hide the post", async () => {
    // Golden Rule #8. Removal is a moderator's decision about content; a report
    // is a signal. If reporting removed anything, one pupil could silence
    // another by objecting to them.
    const { s, tx } = make();
    await s.reportPost(PUPIL, "post-1", "abusive");
    expect(tx.discussionPost.update).not.toHaveBeenCalled();
    expect(tx.discussionComment.update).not.toHaveBeenCalled();
  });

  it("reports a COMMENT against the commenter, not the post's author", async () => {
    const { s, file } = make();
    await s.reportPost(PUPIL, "post-1", "abusive", "cm-1");
    expect((file.mock.calls[0][1] as { againstId: string }).againstId).toBe("pupil-3");
  });

  it("says so, without filing twice, when it has already been reported", async () => {
    const { s, file } = make();
    file.mockResolvedValue({ id: "case-1", alreadyOpen: true });
    await expect(s.reportPost(PUPIL, "post-1", "again")).resolves.toEqual({
      complaintId: "case-1",
      alreadyReported: true,
    });
  });

  it("marks a report about a STAFF author as a staff case", async () => {
    const { s, file } = make({ authorRoles: ["teacher"] });
    await s.reportPost(PUPIL, "post-1", "unfair");
    expect((file.mock.calls[0][1] as { againstType: string }).againstType).toBe("TEACHER");
  });
});

describe("what reporting refuses", () => {
  it("a group the caller is not in the audience of — 404, not 403", async () => {
    // Same rule as reading it. A 403 would confirm the group exists.
    const { s, file } = make({ audience: "STAFF" });
    await expect(s.reportPost(PUPIL, "post-1", "x")).rejects.toThrow(NotFoundException);
    expect(file).not.toHaveBeenCalled();
  });

  it("a post that does not exist", async () => {
    const { s } = make({ post: null });
    await expect(s.reportPost(PUPIL, "post-1", "x")).rejects.toThrow(NotFoundException);
  });

  it("a comment id that is not on that post", async () => {
    const { s } = make({ comment: null });
    await expect(s.reportPost(PUPIL, "post-1", "x", "cm-9")).rejects.toThrow(NotFoundException);
  });

  it("your own post — that is a deletion request, not a complaint", async () => {
    const { s, file } = make({ post: { id: "post-1", groupId: "g1", authorId: PUPIL.userId } });
    await expect(s.reportPost(PUPIL, "post-1", "x")).rejects.toThrow(BadRequestException);
    expect(file).not.toHaveBeenCalled();
  });
});
