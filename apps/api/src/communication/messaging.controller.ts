import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { PageDto, ThreadSummaryDto, ThreadViewDto, UserSummaryDto } from "@sms/types";
import { z } from "zod";
import { COMMUNICATION_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { MessagingService } from "./messaging.service";
import { boundedInt } from "../common/status-filter";

const threadSchema = z.object({
  recipientId: z.string().uuid(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
});
const replySchema = z.object({ body: z.string().min(1).max(5000) });

@RequireModule(MODULES.MESSAGING)
@Controller("messages")
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get("contacts")
  @RequirePermission(COMMUNICATION_PERMISSIONS.MESSAGE_SEND)
  contacts(@CurrentPrincipal() p: Principal, @Query("q") q?: string): Promise<UserSummaryDto[]> {
    return this.messaging.contacts(p, q);
  }

  /** Keyset-paginated: pass the previous response's `nextCursor` as `?cursor=`. */
  @Get("threads")
  @RequirePermission(COMMUNICATION_PERMISSIONS.MESSAGE_READ)
  threads(
    @CurrentPrincipal() p: Principal,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<PageDto<ThreadSummaryDto>> {
    return this.messaging.listThreads(p, { cursor, limit: boundedInt(limit, { field: "limit" }) });
  }

  /** Full-text search across the caller's own messages (GIN-indexed). */
  @Get("search")
  @RequirePermission(COMMUNICATION_PERMISSIONS.MESSAGE_READ)
  search(@CurrentPrincipal() p: Principal, @Query("q") q: string, @Query("limit") limit?: string) {
    return this.messaging.searchMessages(p, q ?? "", boundedInt(limit, { field: "limit" }));
  }

  @Get("threads/:id")
  @RequirePermission(COMMUNICATION_PERMISSIONS.MESSAGE_READ)
  thread(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<ThreadViewDto> {
    return this.messaging.getThread(p, id);
  }

  @Post("threads")
  @RequirePermission(COMMUNICATION_PERMISSIONS.MESSAGE_SEND)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(threadSchema)) body: z.infer<typeof threadSchema>,
  ) {
    return this.messaging.createThread(p, body);
  }

  @Post("threads/:id/reply")
  @RequirePermission(COMMUNICATION_PERMISSIONS.MESSAGE_SEND)
  reply(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(replySchema)) body: { body: string },
  ) {
    return this.messaging.reply(p, id, body.body);
  }
}
