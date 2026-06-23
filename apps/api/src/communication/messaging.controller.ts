import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { COMMUNICATION_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { MessagingService } from "./messaging.service";

const threadSchema = z.object({
  recipientId: z.string().uuid(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
});
const replySchema = z.object({ body: z.string().min(1).max(5000) });

@Controller("messages")
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get("contacts")
  @RequirePermission(COMMUNICATION_PERMISSIONS.MESSAGE_SEND)
  contacts(@CurrentPrincipal() p: Principal) {
    return this.messaging.contacts(p);
  }

  @Get("threads")
  @RequirePermission(COMMUNICATION_PERMISSIONS.MESSAGE_READ)
  threads(@CurrentPrincipal() p: Principal) {
    return this.messaging.listThreads(p);
  }

  @Get("threads/:id")
  @RequirePermission(COMMUNICATION_PERMISSIONS.MESSAGE_READ)
  thread(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
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
