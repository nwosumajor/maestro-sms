import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ANNOUNCEMENT_PERMISSIONS, ANNOUNCEMENT_AUDIENCES } from "@sms/types";
import type { AnnouncementDto, AnnouncementPageDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { pageNumber } from "../common/status-filter";
import type { Principal } from "../integrity/integrity.foundation";
import { AnnouncementsService } from "./announcements.service";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).default("ALL"),
});

@Controller("announcements")
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  /** List the school's announcements visible to the caller. Every role in school. */
  @Get()
  @RequirePermission(ANNOUNCEMENT_PERMISSIONS.ANNOUNCEMENT_READ)
  list(
    @CurrentPrincipal() p: Principal,
    @Query("q") q?: string,
    @Query("page") page?: string,
  ): Promise<AnnouncementPageDto> {
    // `pageNumber` REFUSES a malformed page rather than silently reading it as
    // page one — the shared helper, not a sixth hand-rolled copy.
    return this.announcements.list(p, { q, page: pageNumber(page) });
  }

  /** Post an announcement. principal / school_admin. */
  @Post()
  @RequirePermission(ANNOUNCEMENT_PERMISSIONS.ANNOUNCEMENT_MANAGE)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<AnnouncementDto> {
    return this.announcements.create(p, body);
  }

  @Delete(":id")
  @RequirePermission(ANNOUNCEMENT_PERMISSIONS.ANNOUNCEMENT_MANAGE)
  remove(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.announcements.remove(p, id);
  }
}
