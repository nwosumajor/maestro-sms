import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { MEETING_PERMISSIONS } from "@sms/types";
import type { MeetingSlotDto, MeetingBookingDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { MeetingService } from "./meeting.service";

const slotSchema = z.object({
  teacherId: z.string().uuid().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  capacity: z.number().int().min(1).max(30).optional(),
  location: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
});
const bookSchema = z.object({
  slotId: z.string().uuid(),
  studentId: z.string().uuid(),
  note: z.string().max(500).optional(),
});

@Controller("meetings")
export class MeetingController {
  constructor(private readonly meetings: MeetingService) {}

  // --- host (teacher / staff) ---
  @Get("slots/mine")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_HOST)
  mySlots(@CurrentPrincipal() p: Principal): Promise<MeetingSlotDto[]> {
    return this.meetings.mySlots(p);
  }

  @Post("slots")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_HOST)
  createSlot(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(slotSchema)) body: z.infer<typeof slotSchema>,
  ): Promise<MeetingSlotDto> {
    return this.meetings.createSlot(p, body);
  }

  @Delete("slots/:id")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_HOST)
  withdrawSlot(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.meetings.withdrawSlot(p, id);
  }

  // --- parent ---
  @Get("slots/open")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_BOOK)
  openSlots(@CurrentPrincipal() p: Principal, @Query("teacherId") teacherId?: string): Promise<MeetingSlotDto[]> {
    return this.meetings.openSlots(p, teacherId);
  }

  @Get("bookings/mine")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_BOOK)
  myBookings(@CurrentPrincipal() p: Principal): Promise<MeetingBookingDto[]> {
    return this.meetings.myBookings(p);
  }

  @Post("bookings")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_BOOK)
  book(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(bookSchema)) body: z.infer<typeof bookSchema>,
  ): Promise<MeetingBookingDto> {
    return this.meetings.book(p, body.slotId, body.studentId, body.note);
  }

  // --- cancel (either party) ---
  @Delete("bookings/:id")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_BOOK)
  cancel(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.meetings.cancelBooking(p, id);
  }
}
