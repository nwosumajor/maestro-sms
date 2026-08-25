import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { MEETING_PERMISSIONS , MEETING_REQUEST_TOPICS} from "@sms/types";
import { MEETING_PROVIDERS } from "@sms/types";
import type { MeetingBookingDto, MeetingRequestDto, MeetingSlotDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { MeetingService } from "./meeting.service";
import { MeetingRequestService } from "./meeting-request.service";

const slotSchema = z.object({
  teacherId: z.string().uuid().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  // Ceiling raised for briefings; the SERVICE narrows it by audience (5 for a
  // 1:1 appointment, 2000 for a year group or the school), so the boundary
  // rejects nonsense and the service owns the rule.
  capacity: z.number().int().min(1).max(2000).optional(),
  /** WHO it is for. Omitted = SCHOOL, which is what every slot was before. */
  audience: z
    .object({
      kind: z.enum(["STUDENT", "SELECTED", "CLASS", "STAGE", "SCHOOL"]),
      ref: z.string().max(40).nullish(),
    })
    .optional(),
  /** For a SELECTED audience: the parents to invite. Bounded here AND in the
   *  service — the boundary rejects nonsense, the service owns the rule. */
  inviteeIds: z.array(z.string().uuid()).max(500).optional(),
  /** Colleagues who will also be in the room. The organiser stays teacherId. */
  cohostIds: z.array(z.string().uuid()).max(20).optional(),
  location: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
  // Optional VIDEO meeting. The URL is re-validated server-side (https +
  // per-provider host allowlist) — this only shapes the request.
  provider: z.enum(MEETING_PROVIDERS).nullish(),
  joinUrl: z.string().max(1000).nullish(),
});
const bookSchema = z.object({
  slotId: z.string().uuid(),
  studentId: z.string().uuid(),
  note: z.string().max(500).optional(),
});

const meetingRequestSchema = z.object({
  studentId: z.string().uuid(),
  teacherId: z.string().uuid(),
  topic: z.enum(MEETING_REQUEST_TOPICS),
  note: z.string().max(2000).nullish(),
});
const meetingReviewSchema = z.object({
  action: z.enum(["PASS", "DECLINE"]),
  note: z.string().max(2000).optional(),
});
const meetingDecideSchema = z.object({
  action: z.enum(["ACCEPT", "DECLINE"]),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  note: z.string().max(2000).optional(),
});

@Controller("meetings")
export class MeetingController {
  constructor(
    private readonly meetings: MeetingService,
    private readonly requests: MeetingRequestService,
  ) {}

  // --- host (teacher / staff) ---
  @Get("slots/mine")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_HOST)
  mySlots(@CurrentPrincipal() p: Principal): Promise<MeetingSlotDto[]> {
    return this.meetings.mySlots(p);
  }


  /** The audiences this host may address. Drives the picker; the create
   *  endpoint re-checks, so this is convenience, never the control. */
  @Get("audiences")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_HOST)
  audiences(@CurrentPrincipal() p: Principal) {
    return this.meetings.audienceChoices(p);
  }
  // --- parent-initiated requests --------------------------------------------

  /** A parent asks a teacher for a meeting about their own child. */
  @Post("requests")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_REQUEST)
  createRequest(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(meetingRequestSchema)) b: z.infer<typeof meetingRequestSchema>,
  ) {
    return this.requests.create(p, { ...b, note: b.note ?? null });
  }

  /** The requests this caller may see: a parent's own, a teacher's inbox, or
   *  every one for leadership. `?open=1` narrows to those still awaiting. */
  @Get("requests")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_REQUEST_READ)
  listRequests(@CurrentPrincipal() p: Principal, @Query("open") open?: string): Promise<MeetingRequestDto[]> {
    return this.requests.list(p, { open: open === "1" });
  }

  /** Leadership passes a request to the teacher, or refuses it. */
  @Post("requests/:id/review")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_HOST)
  reviewRequest(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(meetingReviewSchema)) b: z.infer<typeof meetingReviewSchema>,
  ) {
    return this.requests.review(p, id, b.action, b.note);
  }

  /** The teacher answers — accepting opens the meeting itself. */
  @Post("requests/:id/decide")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_HOST)
  decideRequest(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(meetingDecideSchema)) b: z.infer<typeof meetingDecideSchema>,
  ) {
    return this.requests.decide(p, id, b);
  }

  /** The parent withdraws their own request. */
  @Delete("requests/:id")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_REQUEST)
  cancelRequest(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.requests.cancel(p, id);
  }

  @Post("slots")
  @RequirePermission(MEETING_PERMISSIONS.MEETING_HOST)
  createSlot(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(slotSchema)) body: z.infer<typeof slotSchema>,
  ): Promise<MeetingSlotDto> {
    return this.meetings.createSlot(p, {
      ...body,
      // Zod gives `ref?: string | null | undefined`; the service's contract is
      // `string | null`, and SCHOOL legitimately has none.
      audience: body.audience ? { kind: body.audience.kind, ref: body.audience.ref ?? null } : undefined,
    });
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

  /**
   * Cancel a booking — EITHER party, which is what the service has always
   * implemented and what the gate prevented.
   *
   * Deliberately no @RequirePermission, for the same reason as
   * `GET approvals/pending`: no single permission means "a party to this
   * booking". `meeting.book` is held by parents alone and `meeting.host` by
   * staff alone, so gating on either one locks the other out. It was gated on
   * `meeting.book`, so a teacher who fell ill could not release their own slot:
   * cancelling the booking was 403, withdrawing the slot was 409 "the slot has
   * bookings — cancel those first", and the only person who could act was the
   * parent. The error message named the one action the system forbade them.
   *
   * The service decides: the parent who booked, the teacher whose slot it is, or
   * a school-wide administrator. That check already existed — and so did the
   * branch choosing which side to notify when the TEACHER cancels, which could
   * never run.
   */
  @Delete("bookings/:id")
  cancel(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.meetings.cancelBooking(p, id);
  }
}
