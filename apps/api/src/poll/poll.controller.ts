import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { POLL_PERMISSIONS, MODULES } from "@sms/types";
import type { PollDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { PollService } from "./poll.service";

const createSchema = z.object({
  question: z.string().min(1).max(300),
  audience: z.enum(["ALL", "STUDENTS", "STAFF"]).default("ALL"),
  options: z.array(z.string().min(1).max(200)).min(2).max(10),
  closesAt: z.string().nullish(),
});
const voteSchema = z.object({ optionId: z.string().uuid() });

@RequireModule(MODULES.POLL)
@Controller("polls")
export class PollController {
  constructor(private readonly polls: PollService) {}

  @Get()
  @RequirePermission(POLL_PERMISSIONS.POLL_VOTE)
  list(@CurrentPrincipal() p: Principal): Promise<PollDto[]> {
    return this.polls.listPolls(p);
  }

  @Post()
  @RequirePermission(POLL_PERMISSIONS.POLL_MANAGE)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(createSchema)) b: z.infer<typeof createSchema>): Promise<PollDto> {
    return this.polls.createPoll(p, b);
  }

  @Post(":id/close")
  @RequirePermission(POLL_PERMISSIONS.POLL_MANAGE)
  close(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<PollDto> {
    return this.polls.closePoll(p, id);
  }

  @Post(":id/vote")
  @RequirePermission(POLL_PERMISSIONS.POLL_VOTE)
  vote(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(voteSchema)) b: z.infer<typeof voteSchema>): Promise<PollDto> {
    return this.polls.vote(p, id, b.optionId);
  }
}
