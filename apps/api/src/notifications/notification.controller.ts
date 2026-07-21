import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import type { NotificationInboxDto, NotificationPreferenceDto } from "@sms/types";
import { z } from "zod";
import { NOTIFICATION_CHANNELS, NOTIFICATION_PERMISSIONS, NOTIFICATION_TYPES } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { NotificationService } from "./notification.service";

// Loose E.164: 8–15 digits with an optional +. Empty string clears the number.
const phoneSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^(\+?\d{8,15})?$/, "Enter the number in international format, e.g. +2348012345678"),
});

const preferencesSchema = z.object({
  emailEnabled: z.boolean(),
  smsEnabled: z.boolean(),
  whatsappEnabled: z.boolean(),
  mutedTypes: z.array(z.string().max(64)).max(100),
});

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
  list(@CurrentPrincipal() p: Principal, @Query("unread") unread?: string): Promise<NotificationInboxDto> {
    return this.notifications.listMine(p, { unreadOnly: unread === "1" || unread === "true" });
  }

  /** Mark one of the caller's own notifications read. */
  @Post(":id/read")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  markRead(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.notifications.markRead(p, id);
  }

  /** The caller's own mobile number (SMS/WhatsApp delivery target). */
  @Get("me/phone")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  myPhone(@CurrentPrincipal() p: Principal) {
    return this.notifications.getMyPhone(p);
  }

  /** Set/clear the caller's own mobile number. Self-scoped; audited. */
  @Put("me/phone")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  setMyPhone(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(phoneSchema)) body: z.infer<typeof phoneSchema>,
  ) {
    return this.notifications.setMyPhone(p, body.phone || null);
  }

  /** The caller's own external-channel delivery preferences (self-scoped). */
  @Get("me/preferences")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  myPreferences(@CurrentPrincipal() p: Principal): Promise<NotificationPreferenceDto> {
    return this.notifications.getMyPreferences(p);
  }

  @Put("me/preferences")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  setMyPreferences(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(preferencesSchema)) body: z.infer<typeof preferencesSchema>,
  ): Promise<NotificationPreferenceDto> {
    return this.notifications.setMyPreferences(p, body);
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
