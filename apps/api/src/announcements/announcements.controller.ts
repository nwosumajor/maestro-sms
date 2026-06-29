import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { ANNOUNCEMENT_PERMISSIONS, ANNOUNCEMENT_AUDIENCES } from "@sms/types";
import type { AnnouncementDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
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
  list(@CurrentPrincipal() p: Principal): Promise<AnnouncementDto[]> {
    return this.announcements.list(p);
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
