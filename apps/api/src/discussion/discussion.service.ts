// =============================================================================
// DiscussionService — topic-group discussion hub
// =============================================================================
// Tenant-scoped (RLS). Staff (discussion.moderate) create groups + delete any
// unwanted post/comment (soft-delete, audited). Members (discussion.participate)
// see groups for their audience, post, and comment. Deleted content is replaced
// with a tombstone in reads — never the original body. Audited.
// =============================================================================

import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { DiscussionGroupDto, DiscussionPostDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const STUDENT_SIDE_ROLES = new Set(["student", "parent"]);
const TOMBSTONE = "[removed by a moderator]";

@Injectable()
export class DiscussionService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private canModerate(p: Principal): boolean {
    return p.permissions.includes("discussion.moderate");
  }
  private audiences(p: Principal): string[] {
    const studentSideOnly = p.roles.every((r) => STUDENT_SIDE_ROLES.has(r));
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
      const groups = await tx.discussionGroup.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 });
      return Promise.all(groups.map((g: { id: string }) => this.groupDto(tx, g.id)));
    });
  }

  // --- posts + comments -----------------------------------------------------

  async listPosts(p: Principal, groupId: string): Promise<DiscussionPostDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const group = await tx.discussionGroup.findFirst({ where: { id: groupId } });
      if (!group) throw new NotFoundException("Group not found");
      if (!this.canModerate(p) && !this.audiences(p).includes(group.audience)) throw new NotFoundException("Group not found");
      const posts = await tx.discussionPost.findMany({ where: { groupId }, orderBy: { createdAt: "desc" }, take: 200 });
      return Promise.all(posts.map((post: { id: string }) => this.postDto(tx, post.id)));
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

  private async groupDto(tx: TenantTx, groupId: string): Promise<DiscussionGroupDto> {
    const g = await tx.discussionGroup.findFirstOrThrow({ where: { id: groupId } });
    const postCount = await tx.discussionPost.count({ where: { groupId, deleted: false } });
    const creator = await tx.user.findFirst({ where: { id: g.createdById }, select: { name: true } });
    return { id: g.id, name: g.name, description: g.description, audience: g.audience, createdByName: creator?.name ?? "", postCount, createdAt: g.createdAt };
  }

  private async postDto(tx: TenantTx, postId: string): Promise<DiscussionPostDto> {
    const post = await tx.discussionPost.findFirstOrThrow({ where: { id: postId } });
    const comments = await tx.discussionComment.findMany({ where: { postId }, orderBy: { createdAt: "asc" } });
    const ids = [...new Set([post.authorId, ...comments.map((c: { authorId: string }) => c.authorId)])];
    const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
    return {
      id: post.id,
      groupId: post.groupId,
      authorId: post.authorId,
      authorName: nameOf.get(post.authorId) ?? "",
      body: post.deleted ? TOMBSTONE : post.body,
      deleted: post.deleted,
      comments: comments.map((c: { id: string; authorId: string; body: string; deleted: boolean; createdAt: Date }) => ({
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

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "discussion", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
