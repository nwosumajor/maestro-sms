import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { NOTIFICATION_CHANNELS, NOTIFICATION_PERMISSIONS, NOTIFICATION_TYPES } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { NotificationService } from "./notification.service";

const sendSchema = z.object({
  recipientId: z.string().uuid(),
  type: z.enum(NOTIFICATION_TYPES).default("ANNOUNCEMENT"),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  data: z.record(z.unknown()).optional(),
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).optional(),
});

@Controller("notifications")
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /** The caller's own inbox (self-scoped). `?unread=1` for unread only. */
  @Get()
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  list(@CurrentPrincipal() p: Principal, @Query("unread") unread?: string) {
    return this.notifications.listMine(p, { unreadOnly: unread === "1" || unread === "true" });
  }

  /** Mark one of the caller's own notifications read. */
  @Post(":id/read")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  markRead(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.notifications.markRead(p, id);
  }

  /** Staff send to a user (relationship-scoped in the service). */
  @Post()
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_SEND)
  send(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(sendSchema)) body: z.infer<typeof sendSchema>,
  ) {
    return this.notifications.send(p, body);
  }
}
