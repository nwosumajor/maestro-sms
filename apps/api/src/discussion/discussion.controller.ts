import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { DISCUSSION_PERMISSIONS, MODULES } from "@sms/types";
import type { DiscussionGroupDto, DiscussionPostDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { DiscussionService } from "./discussion.service";

const groupSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(1000).optional(),
  audience: z.enum(["ALL", "STUDENTS", "STAFF"]).default("ALL"),
});
const bodySchema = z.object({ body: z.string().min(1).max(5000) });

@RequireModule(MODULES.DISCUSSION)
@Controller("discussion")
export class DiscussionController {
  constructor(private readonly discussion: DiscussionService) {}

  @Get("groups")
  @RequirePermission(DISCUSSION_PERMISSIONS.DISCUSSION_PARTICIPATE)
  groups(@CurrentPrincipal() p: Principal): Promise<DiscussionGroupDto[]> {
    return this.discussion.listGroups(p);
  }

  @Post("groups")
  @RequirePermission(DISCUSSION_PERMISSIONS.DISCUSSION_MODERATE)
  createGroup(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(groupSchema)) b: z.infer<typeof groupSchema>): Promise<DiscussionGroupDto> {
    return this.discussion.createGroup(p, b);
  }

  @Get("groups/:id/posts")
  @RequirePermission(DISCUSSION_PERMISSIONS.DISCUSSION_PARTICIPATE)
  posts(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<DiscussionPostDto[]> {
    return this.discussion.listPosts(p, id);
  }

  @Post("groups/:id/posts")
  @RequirePermission(DISCUSSION_PERMISSIONS.DISCUSSION_PARTICIPATE)
  post(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(bodySchema)) b: z.infer<typeof bodySchema>): Promise<DiscussionPostDto> {
    return this.discussion.createPost(p, id, b.body);
  }

  @Post("posts/:id/comments")
  @RequirePermission(DISCUSSION_PERMISSIONS.DISCUSSION_PARTICIPATE)
  comment(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(bodySchema)) b: z.infer<typeof bodySchema>): Promise<DiscussionPostDto> {
    return this.discussion.comment(p, id, b.body);
  }

  @Delete("posts/:id")
  @RequirePermission(DISCUSSION_PERMISSIONS.DISCUSSION_MODERATE)
  deletePost(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.discussion.deletePost(p, id);
  }

  @Delete("comments/:id")
  @RequirePermission(DISCUSSION_PERMISSIONS.DISCUSSION_MODERATE)
  deleteComment(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.discussion.deleteComment(p, id);
  }
}
