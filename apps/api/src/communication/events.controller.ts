import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
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
});

@Controller("events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @RequirePermission(COMMUNICATION_PERMISSIONS.EVENT_READ)
  list(@CurrentPrincipal() p: Principal): Promise<CalendarEventDto[]> {
    return this.events.listEvents(p);
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
