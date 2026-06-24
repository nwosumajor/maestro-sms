import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { IdNameDto, PeriodDto, TimetableEntryDto } from "@sms/types";
import { z } from "zod";
import { DAYS_OF_WEEK, TIMETABLE_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { TimetableService } from "./timetable.service";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const periodSchema = z.object({
  name: z.string().min(1).max(60),
  sequence: z.number().int().min(1).max(50),
  startTime: hhmm,
  endTime: hhmm,
});
const periodUpdateSchema = periodSchema.partial();
const roomSchema = z.object({ name: z.string().min(1).max(80), capacity: z.number().int().min(1).nullish() });
const roomUpdateSchema = roomSchema.partial();
const entrySchema = z.object({
  classId: z.string().uuid(),
  dayOfWeek: z.enum(DAYS_OF_WEEK),
  periodId: z.string().uuid(),
  subject: z.string().min(1).max(120),
  teacherId: z.string().uuid(),
  roomId: z.string().uuid().nullish(),
});
const entryUpdateSchema = entrySchema.partial();

@RequireModule(MODULES.TIMETABLE)
@Controller("timetable")
export class TimetableController {
  constructor(private readonly timetable: TimetableService) {}

  // --- periods ---
  @Get("periods")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  listPeriods(@CurrentPrincipal() p: Principal): Promise<PeriodDto[]> {
    return this.timetable.listPeriods(p);
  }

  @Post("periods")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  createPeriod(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(periodSchema)) body: z.infer<typeof periodSchema>,
  ) {
    return this.timetable.createPeriod(p, body);
  }

  @Patch("periods/:id")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  updatePeriod(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(periodUpdateSchema)) body: z.infer<typeof periodUpdateSchema>,
  ) {
    return this.timetable.updatePeriod(p, id, body);
  }

  // --- rooms ---
  @Get("rooms")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  listRooms(@CurrentPrincipal() p: Principal): Promise<IdNameDto[]> {
    return this.timetable.listRooms(p);
  }

  @Post("rooms")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  createRoom(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(roomSchema)) body: z.infer<typeof roomSchema>,
  ) {
    return this.timetable.createRoom(p, body);
  }

  @Patch("rooms/:id")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  updateRoom(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(roomUpdateSchema)) body: z.infer<typeof roomUpdateSchema>,
  ) {
    return this.timetable.updateRoom(p, id, body);
  }

  // --- entries (conflict-checked) ---
  @Post("entries")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  createEntry(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(entrySchema)) body: z.infer<typeof entrySchema>,
  ) {
    return this.timetable.createEntry(p, body);
  }

  @Patch("entries/:id")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  updateEntry(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(entryUpdateSchema)) body: z.infer<typeof entryUpdateSchema>,
  ) {
    return this.timetable.updateEntry(p, id, body);
  }

  @Delete("entries/:id")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  deleteEntry(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.timetable.deleteEntry(p, id);
  }

  @Get("entries")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  listEntries(
    @CurrentPrincipal() p: Principal,
    @Query("classId") classId?: string,
    @Query("teacherId") teacherId?: string,
    @Query("dayOfWeek") dayOfWeek?: string,
  ) {
    const day = dayOfWeek && DAYS_OF_WEEK.includes(dayOfWeek as never) ? (dayOfWeek as never) : undefined;
    return this.timetable.listEntries(p, { classId, teacherId, dayOfWeek: day });
  }

  @Get("classes/:classId")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  classTimetable(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<TimetableEntryDto[]> {
    return this.timetable.getClassTimetable(p, classId);
  }
}
