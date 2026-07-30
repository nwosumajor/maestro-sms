import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { MEETING_PROVIDERS } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { CalendarEventDto } from "@sms/types";
import { z } from "zod";
import { COMMUNICATION_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { EventsService } from "./events.service";

const eventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullish(),
  allDay: z.boolean().optional(),
  audience: z.enum(["ALL", "STAFF"]).optional(),
  // Recurrence: ONE row describes the series; occurrences are expanded on read.
  recurrence: z.enum(["NONE", "DAILY", "WEEKLY", "MONTHLY"]).optional(),
  recurrenceUntil: z.string().datetime().nullish(),
  recurrenceDays: z.array(z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"])).max(7).optional(),
  // Optional VIDEO meeting (staff meetings, parents evening, assemblies). The
  // URL is re-validated server-side; this only shapes the request.
  provider: z.enum(MEETING_PROVIDERS).nullish(),
  joinUrl: z.string().max(1000).nullish(),
});

@RequireModule(MODULES.CALENDAR)
@Controller("events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** Events in a window (defaults to a sensible range). Recurring series are
   *  expanded to their occurrences inside the window. */
  @Get()
  @RequirePermission(COMMUNICATION_PERMISSIONS.EVENT_READ)
  list(
    @CurrentPrincipal() p: Principal,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<CalendarEventDto[]> {
    return this.events.listEvents(p, { from, to });
  }

  @Post()
  @RequirePermission(COMMUNICATION_PERMISSIONS.EVENT_WRITE)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(eventSchema)) body: z.infer<typeof eventSchema>,
  ) {
    return this.events.createEvent(p, body);
  }

  @Delete(":id")
  @RequirePermission(COMMUNICATION_PERMISSIONS.EVENT_WRITE)
  remove(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.events.deleteEvent(p, id);
  }
}
