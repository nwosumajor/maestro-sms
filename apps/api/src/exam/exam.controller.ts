import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { EXAM_PERMISSIONS } from "@sms/types";
import type { ExamSittingDto, ExamSeatDto, InvigilationDto, MyExamDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { ExamService } from "./exam.service";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const sittingSchema = z.object({
  title: z.string().min(1).max(200),
  subject: z.string().max(120).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startsAt: hhmm,
  endsAt: hhmm,
  hall: z.string().min(1).max(120),
  capacity: z.number().int().min(0).max(2000).optional(),
  note: z.string().max(500).optional(),
});
const seatSchema = z.object({ studentIds: z.array(z.string().uuid()).max(2000).optional(), classId: z.string().uuid().optional() });
const invigSchema = z.object({ staffId: z.string().uuid(), lead: z.boolean().optional() });

@Controller("exams")
export class ExamController {
  constructor(private readonly exams: ExamService) {}

  // --- student / parent / invigilator self views (gated on timetable.read,
  //     which students, parents and staff all hold) ---
  @Get("mine")
  @RequirePermission("timetable.read")
  myExams(@CurrentPrincipal() p: Principal): Promise<MyExamDto[]> {
    return this.exams.myExams(p);
  }

  @Get("invigilations/mine")
  @RequirePermission("timetable.read")
  myInvigilations(@CurrentPrincipal() p: Principal): Promise<MyExamDto[]> {
    return this.exams.myInvigilations(p);
  }

  // --- staff management ---
  @Get()
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  list(@CurrentPrincipal() p: Principal): Promise<ExamSittingDto[]> {
    return this.exams.listSittings(p);
  }

  @Post()
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(sittingSchema)) body: z.infer<typeof sittingSchema>,
  ): Promise<ExamSittingDto> {
    return this.exams.createSitting(p, body);
  }

  @Delete(":id")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  remove(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.exams.deleteSitting(p, id);
  }

  @Get(":id/seats")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  seats(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<ExamSeatDto[]> {
    return this.exams.getSeatPlan(p, id);
  }

  /** Seat a list of students, or auto-seat a whole class. */
  @Post(":id/seats")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  seat(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(seatSchema)) body: z.infer<typeof seatSchema>,
  ): Promise<ExamSeatDto[]> {
    if (body.classId) return this.exams.seatClass(p, id, body.classId);
    return this.exams.seat(p, id, body.studentIds ?? []);
  }

  @Get(":id/invigilators")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  invigilators(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<InvigilationDto[]> {
    return this.exams.getInvigilators(p, id);
  }

  @Post(":id/invigilators")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  addInvigilator(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(invigSchema)) body: z.infer<typeof invigSchema>,
  ): Promise<InvigilationDto> {
    return this.exams.assignInvigilator(p, id, body.staffId, body.lead ?? false);
  }

  @Delete(":id/invigilators/:staffId")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  removeInvigilator(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Param("staffId") staffId: string) {
    return this.exams.removeInvigilator(p, id, staffId);
  }
}
