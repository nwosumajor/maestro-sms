import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import { POLL_PERMISSIONS, MODULES } from "@sms/types";
import type { PageDto, PollDto } from "@sms/types";
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
// Same bounds as createSchema — an edit surface must not accept a poll that
// could not have been created.
const updateSchema = z.object({
  question: z.string().min(1).max(300).optional(),
  audience: z.enum(["ALL", "STUDENTS", "STAFF"]).optional(),
  closesAt: z.string().nullish(),
});
const optionsSchema = z.object({ options: z.array(z.string().min(1).max(200)).min(2).max(10) });
const voteSchema = z.object({ optionId: z.string().uuid() });

@RequireModule(MODULES.POLL)
@Controller("polls")
export class PollController {
  constructor(private readonly polls: PollService) {}

  @Get()
  @RequirePermission(POLL_PERMISSIONS.POLL_VOTE)
  list(@CurrentPrincipal() p: Principal, @Query("cursor") cursor?: string, @Query("limit") limit?: string): Promise<PageDto<PollDto>> {
    return this.polls.listPolls(p, { cursor, limit: limit ? Number(limit) : undefined });
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

  /** Correct the question, audience or deadline. Fixed once anyone has voted,
   *  except the deadline. */
  @Put(":id")
  @RequirePermission(POLL_PERMISSIONS.POLL_MANAGE)
  update(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateSchema)) b: z.infer<typeof updateSchema>,
  ): Promise<PollDto> {
    return this.polls.updatePoll(p, id, b);
  }

  /** Replace the option list. Refused once anyone has voted. */
  @Put(":id/options")
  @RequirePermission(POLL_PERMISSIONS.POLL_MANAGE)
  setOptions(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(optionsSchema)) b: z.infer<typeof optionsSchema>,
  ): Promise<PollDto> {
    return this.polls.setPollOptions(p, id, b.options);
  }

  @Delete(":id")
  @RequirePermission(POLL_PERMISSIONS.POLL_MANAGE)
  remove(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.polls.deletePoll(p, id);
  }

  @Post(":id/vote")
  @RequirePermission(POLL_PERMISSIONS.POLL_VOTE)
  vote(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(voteSchema)) b: z.infer<typeof voteSchema>): Promise<PollDto> {
    return this.polls.vote(p, id, b.optionId);
  }
}
