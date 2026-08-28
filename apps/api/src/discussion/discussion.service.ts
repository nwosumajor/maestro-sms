// =============================================================================
// DiscussionService — topic-group discussion hub
// =============================================================================
// Tenant-scoped (RLS). Staff (discussion.moderate) create groups + delete any
// unwanted post/comment (soft-delete, audited). Members (discussion.participate)
// see groups for their audience, post, and comment. Deleted content is replaced
// with a tombstone in reads — never the original body. Audited.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isStaffRoles } from "@sms/types";
import type { DiscussionGroupDto, DiscussionPostDto, PageDto } from "@sms/types";
import { decodeCursor, pageLimit, seekWhere, toPage } from "../common/keyset-cursor";
import { DisciplineService } from "../discipline/discipline.service";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const TOMBSTONE = "[removed by a moderator]";

@Injectable()
export class DiscussionService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    // Reporting files a DISCIPLINE COMPLAINT rather than inventing a parallel
    // pipeline. One-way: Discipline knows nothing about Discussion, so there is
    // no cycle (DisciplineModule imports only NotificationModule).
    private readonly discipline: DisciplineService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private canModerate(p: Principal): boolean {
    return p.permissions.includes("discussion.moderate");
  }
  private audiences(p: Principal): string[] {
    const studentSideOnly = !isStaffRoles(p.roles);
    return studentSideOnly ? ["ALL", "STUDENTS"] : ["ALL", "STUDENTS", "STAFF"];
  }

  // --- groups ---------------------------------------------------------------

  async createGroup(p: Principal, input: { name: string; description?: string; audience: "ALL" | "STUDENTS" | "STAFF" }): Promise<DiscussionGroupDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const g = await tx.discussionGroup.create({
        data: { schoolId: p.schoolId, name: input.name, description: input.description ?? null, audience: input.audience, createdById: p.userId },
      });
      await this.log(tx, p, "discussion.group.create", g.id, { audience: input.audience });
      return this.groupDto(tx, g.id);
    });
  }

  async listGroups(p: Principal): Promise<DiscussionGroupDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where = this.canModerate(p) ? {} : { audience: { in: this.audiences(p) } };
      const groups = (await tx.discussionGroup.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 100,
      })) as GroupRow[];
      if (!groups.length) return [];
      // // GOTCHA: `groupDto(tx, g.id)` per group re-fetched a row already in
      // hand and then ran a post COUNT and a creator lookup for it — three
      // queries per group, a hundred groups, three hundred round trips. The
      // post counts are one aggregate now.
      const ids = groups.map((g) => g.id);
      const [counts, creators] = await Promise.all([
        tx.discussionPost.groupBy({
          by: ["groupId"],
          where: { groupId: { in: ids }, deleted: false },
          _count: true,
        }) as unknown as Promise<Array<{ groupId: string; _count: number }>>,
        tx.user.findMany({
          where: { id: { in: [...new Set(groups.map((g) => g.createdById))] } },
          select: { id: true, name: true },
        }),
      ]);
      const postCount = new Map(counts.map((c) => [c.groupId, c._count]));
      const nameOf = new Map(creators.map((u: { id: string; name: string }) => [u.id, u.name]));
      return groups.map((g) => this.groupDtoWith(g, postCount.get(g.id) ?? 0, nameOf.get(g.createdById) ?? ""));
    });
  }

  // --- posts + comments -----------------------------------------------------

  /**
   * Full-text search over posts in groups the caller may see. Postgres FTS
   * (GIN-indexed on to_tsvector(body)) rather than ILIKE '%x%', which cannot use
   * an index and degrades linearly as the forum grows. Moderated (soft-deleted)
   * posts are excluded so a tombstoned body can never surface via search.
   */
  async searchPosts(p: Principal, q: string, limit = 30) {
    const term = (q ?? "").trim();
    if (term.length < 2) return [];
    const capped = Math.min(Math.max(1, limit), 50);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const groups = await tx.discussionGroup.findMany({
        where: this.canModerate(p) ? {} : { audience: { in: this.audiences(p) } },
        select: { id: true },
        take: 500,
      });
      const ids = groups.map((g: { id: string }) => g.id);
      if (ids.length === 0) return [];
      return tx.$queryRaw<Array<{ id: string; groupId: string; authorId: string; body: string; createdAt: Date; groupName: string }>>`
        SELECT dp.id, dp."groupId", dp."authorId", dp.body, dp."createdAt", dg.name AS "groupName"
        FROM "discussion_post" dp
        JOIN "discussion_group" dg ON dg.id = dp."groupId"
        WHERE dp."groupId" = ANY(${ids}::uuid[])
          AND dp.deleted = false
          AND to_tsvector('english', dp.body) @@ plainto_tsquery('english', ${term})
        ORDER BY dp."createdAt" DESC
        LIMIT ${capped}
      `;
    });
  }

  async listPosts(p: Principal, groupId: string, opts: { cursor?: string; limit?: number } = {}): Promise<PageDto<DiscussionPostDto>> {
    const limit = pageLimit(opts.limit);
    const cursor = decodeCursor(opts.cursor);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const group = await tx.discussionGroup.findFirst({ where: { id: groupId } });
      if (!group) throw new NotFoundException("Group not found");
      if (!this.canModerate(p) && !this.audiences(p).includes(group.audience)) throw new NotFoundException("Group not found");
      const rows = (await tx.discussionPost.findMany({
        where: { groupId, ...seekWhere(cursor) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      })) as PostRow[];
      const page = toPage(rows, limit);
      const posts = page.items;
      if (posts.length === 0) return { items: [], nextCursor: null };
      // Batch comments + author names into ONE query each (was 3 queries per post
      // via postDto — ~600 for a busy 200-post group).
      const postIds = posts.map((x) => x.id);
      const comments = (await tx.discussionComment.findMany({
        where: { postId: { in: postIds } },
        orderBy: { createdAt: "asc" },
      })) as CommentRow[];
      const ids = [...new Set([...posts.map((x) => x.authorId), ...comments.map((c) => c.authorId)])];
      const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      const nameOf = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
      const byPost = new Map<string, CommentRow[]>();
      for (const c of comments) byPost.set(c.postId, [...(byPost.get(c.postId) ?? []), c]);
      return {
        items: posts.map((post) => mapPostDto(post, byPost.get(post.id) ?? [], nameOf)),
        nextCursor: page.nextCursor,
      };
    });
  }

  async createPost(p: Principal, groupId: string, body: string): Promise<DiscussionPostDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const group = await tx.discussionGroup.findFirst({ where: { id: groupId } });
      if (!group) throw new NotFoundException("Group not found");
      if (!this.canModerate(p) && !this.audiences(p).includes(group.audience)) throw new ForbiddenException("Not in this group's audience");
      const post = await tx.discussionPost.create({ data: { schoolId: p.schoolId, groupId, authorId: p.userId, body } });
      await this.log(tx, p, "discussion.post.create", post.id, { groupId });
      return this.postDto(tx, post.id);
    });
  }

  async comment(p: Principal, postId: string, body: string): Promise<DiscussionPostDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const post = await tx.discussionPost.findFirst({ where: { id: postId } });
      if (!post) throw new NotFoundException("Post not found");
      const group = await tx.discussionGroup.findFirst({ where: { id: post.groupId } });
      if (!group) throw new NotFoundException("Post not found");
      if (!this.canModerate(p) && !this.audiences(p).includes(group.audience)) throw new ForbiddenException("Not in this group's audience");
      await tx.discussionComment.create({ data: { schoolId: p.schoolId, postId, authorId: p.userId, body } });
      await this.log(tx, p, "discussion.comment.create", postId, {});
      return this.postDto(tx, postId);
    });
  }

  // --- reporting -------------------------------------------------------------
  //
  // Moderation existed and discovery did not. A moderator could remove any post,
  // but nothing let a reader say "look at this" — so in a school with hundreds of
  // pupils posting, harmful content was removed only if a member of staff
  // happened to be reading the thread at the time. That is not moderation, it is
  // chance, and the person most likely to see it first is a child with no way to
  // act.
  //
  // A report is a DISCIPLINE COMPLAINT, not a new parallel pipeline: it is a
  // record that somebody objects to another person's conduct, which is exactly
  // what that module already models, reviews, assigns and resolves. Reusing it
  // means a forum report inherits staff review, the "never visible to the person
  // it is about" rule, and the human-only outcome.
  //
  // SECURITY: the reporter never names the person. They name a POST, and the
  // server resolves the author from a row it has already checked they may see —
  // so there is no id to guess, which is what the roster check on the ordinary
  // filing path exists to prevent.
  //
  // GOLDEN RULE #8: reporting does NOT hide the post. If it did, any pupil could
  // silence any other by objecting to them. A report is a signal for a human.

  /** Report a post, or a comment on one, to the school's discipline process. */
  async reportPost(
    p: Principal,
    postId: string,
    reason: string,
    commentId?: string,
  ): Promise<{ complaintId: string; alreadyReported: boolean }> {
    const target = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const post = (await tx.discussionPost.findFirst({ where: { id: postId } })) as
        | { id: string; groupId: string; authorId: string }
        | null;
      if (!post) throw new NotFoundException("Post not found");
      const group = (await tx.discussionGroup.findFirst({ where: { id: post.groupId } })) as
        | { id: string; name: string; audience: string }
        | null;
      if (!group) throw new NotFoundException("Post not found");
      // The same visibility rule reading the group uses. 404-not-403: a group
      // outside the caller's audience does not exist to them.
      if (!this.canModerate(p) && !this.audiences(p).includes(group.audience)) {
        throw new NotFoundException("Post not found");
      }
      let authorId = post.authorId;
      if (commentId) {
        const comment = (await tx.discussionComment.findFirst({ where: { id: commentId, postId } })) as
          | { id: string; authorId: string }
          | null;
        if (!comment) throw new NotFoundException("Comment not found");
        authorId = comment.authorId;
      }
      const roles = (await tx.userRole.findMany({
        where: { userId: authorId },
        select: { role: { select: { name: true } } },
      })) as Array<{ role: { name: string } }>;
      const isStudent = roles.some((r) => r.role.name === "student");
      return { authorId, groupName: group.name, isStudent };
    });

    if (target.authorId === p.userId) {
      throw new BadRequestException("You cannot report your own post — ask a teacher to remove it.");
    }

    // The subject is STABLE for this reporter and this content, which is what
    // makes a repeat report idempotent rather than a way to bury the real ones.
    const ref = commentId ? `comment ${commentId}` : `post ${postId}`;
    const filed = await this.discipline.fileAboutVisibleContent(p, {
      subject: `Reported ${commentId ? "comment" : "post"} in "${target.groupName}"`,
      details: `${reason}\n\n(Reported ${ref} in discussion group "${target.groupName}".)`,
      againstId: target.authorId,
      againstType: target.isStudent ? "STUDENT" : "TEACHER",
    });
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.log(tx, p, "discussion.report", postId, { commentId: commentId ?? null, complaintId: filed.id }),
    );
    return { complaintId: filed.id, alreadyReported: filed.alreadyOpen };
  }

  // --- moderation (soft-delete) ---------------------------------------------

  async deletePost(p: Principal, postId: string): Promise<{ id: string; deleted: true }> {
    if (!this.canModerate(p)) throw new ForbiddenException("Not allowed");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const post = await tx.discussionPost.findFirst({ where: { id: postId }, select: { id: true } });
      if (!post) throw new NotFoundException("Post not found");
      await tx.discussionPost.update({ where: { id: postId }, data: { deleted: true } });
      await this.log(tx, p, "discussion.post.delete", postId, {});
      return { id: postId, deleted: true as const };
    });
  }

  async deleteComment(p: Principal, commentId: string): Promise<{ id: string; deleted: true }> {
    if (!this.canModerate(p)) throw new ForbiddenException("Not allowed");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const c = await tx.discussionComment.findFirst({ where: { id: commentId }, select: { id: true } });
      if (!c) throw new NotFoundException("Comment not found");
      await tx.discussionComment.update({ where: { id: commentId }, data: { deleted: true } });
      await this.log(tx, p, "discussion.comment.delete", commentId, {});
      return { id: commentId, deleted: true as const };
    });
  }

  // --- helpers --------------------------------------------------------------

  /** One group, when the caller has only an id. */
  private async groupDto(tx: TenantTx, groupId: string): Promise<DiscussionGroupDto> {
    const g = (await tx.discussionGroup.findFirstOrThrow({ where: { id: groupId } })) as GroupRow;
    const [postCount, creator] = await Promise.all([
      tx.discussionPost.count({ where: { groupId, deleted: false } }),
      tx.user.findFirst({ where: { id: g.createdById }, select: { name: true } }),
    ]);
    return this.groupDtoWith(g, postCount, creator?.name ?? "");
  }

  private groupDtoWith(g: GroupRow, postCount: number, createdByName: string): DiscussionGroupDto {
    return { id: g.id, name: g.name, description: g.description, audience: g.audience, createdByName, postCount, createdAt: g.createdAt };
  }

  private async postDto(tx: TenantTx, postId: string): Promise<DiscussionPostDto> {
    const post = await tx.discussionPost.findFirstOrThrow({ where: { id: postId } });
    const comments = await tx.discussionComment.findMany({ where: { postId }, orderBy: { createdAt: "asc" } });
    const ids = [...new Set([post.authorId, ...comments.map((c: { authorId: string }) => c.authorId)])];
    const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
    return mapPostDto(post as PostRow, comments as CommentRow[], nameOf);
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "discussion", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}

type PostRow = { id: string; groupId: string; authorId: string; body: string; deleted: boolean; createdAt: Date };
type GroupRow = { id: string; name: string; description: string | null; audience: string; createdById: string; createdAt: Date };
type CommentRow = { id: string; postId: string; authorId: string; body: string; deleted: boolean; createdAt: Date };

/**
 * Pure post-row → DTO. Comments and author names are supplied by the caller —
 * fetched once for a single post or batched across the group — so listing never
 * fans out into a per-post query storm. A moderated post/comment keeps its row
 * but shows the tombstone instead of its body.
 */
function mapPostDto(post: PostRow, comments: CommentRow[], nameOf: Map<string, string>): DiscussionPostDto {
  return {
    id: post.id,
    groupId: post.groupId,
    authorId: post.authorId,
    authorName: nameOf.get(post.authorId) ?? "",
    body: post.deleted ? TOMBSTONE : post.body,
    deleted: post.deleted,
    comments: comments.map((c) => ({
      id: c.id,
      authorId: c.authorId,
      authorName: nameOf.get(c.authorId) ?? "",
      body: c.deleted ? TOMBSTONE : c.body,
      deleted: c.deleted,
      createdAt: c.createdAt,
    })),
    createdAt: post.createdAt,
  };
}
