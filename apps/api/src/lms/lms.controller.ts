import { Body, Controller, Get, Header, Param, Post, Put } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { AcademicSessionDto, ClassDto, ClassEligibilityDto, ClassInfoDto, ClassSubjectDto, IdNameDto, PromotionBatchDto, SubjectDto, UserWithEmailDto } from "@sms/types";
import { z } from "zod";
import { LMS_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { LmsService } from "./lms.service";
import { PromotionService } from "./promotion.service";
import { AcademicService } from "./academic.service";

const createClassSchema = z.object({
  name: z.string().min(1),
  subject: z.string().optional(),
  level: z.number().int().min(0).max(50).nullish(),
  nextClassId: z.string().uuid().nullish(),
});
const updateClassSchema = z.object({
  name: z.string().min(1).optional(),
  subject: z.string().nullish(),
  level: z.number().int().min(0).max(50).nullish(),
  nextClassId: z.string().uuid().nullish(),
  supervisorId: z.string().uuid().nullish(),
  capacity: z.number().int().min(0).max(10000).nullish(),
});
const enrollStatusSchema = z.object({
  status: z.enum(["ACTIVE", "TRANSFERRED", "WITHDRAWN"]),
  reason: z.string().max(500).optional(),
});
const sessionSchema = z.object({
  name: z.string().min(1).max(60),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});
const termSchema = z.object({ name: z.string().min(1).max(60), sequence: z.number().int().min(1).max(6) });
const teacherSchema = z.object({ teacherId: z.string().uuid() });
const studentSchema = z.object({ studentId: z.string().uuid() });
const guardianSchema = z.object({ parentId: z.string().uuid(), studentId: z.string().uuid() });
const subjectSchema = z.object({ name: z.string().min(1).max(120), code: z.string().max(30).nullish() });
const classSubjectSchema = z.object({ subjectId: z.string().uuid(), teacherId: z.string().uuid() });
const promotionSchema = z.object({
  sourceClassId: z.string().uuid(),
  targetClassId: z.string().uuid().nullish(),
  studentIds: z.array(z.string().uuid()).max(2000).optional(),
});
const promoteRejectSchema = z.object({ note: z.string().max(1000).optional() });

@RequireModule(MODULES.LMS)
@Controller()
export class LmsController {
  constructor(
    private readonly lms: LmsService,
    private readonly promotion: PromotionService,
    private readonly academic: AcademicService,
  ) {}

  @Post("classes")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  createClass(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createClassSchema)) body: { name: string; subject?: string },
  ) {
    return this.lms.createClass(p, body);
  }

  /** Update class progression (level / next class) + supervisor + metadata. */
  @Put("classes/:classId")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  updateClass(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(updateClassSchema)) body: z.infer<typeof updateClassSchema>,
  ) {
    return this.lms.updateClass(p, classId, body);
  }

  // --- subject catalog + per-class offerings --------------------------------
  @Post("subjects")
  @RequirePermission(LMS_PERMISSIONS.SUBJECT_MANAGE)
  createSubject(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(subjectSchema)) body: z.infer<typeof subjectSchema>,
  ): Promise<SubjectDto> {
    return this.lms.createSubject(p, body);
  }

  @Get("subjects")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  subjects(@CurrentPrincipal() p: Principal): Promise<SubjectDto[]> {
    return this.lms.listSubjects(p);
  }

  @Post("classes/:classId/subjects")
  @RequirePermission(LMS_PERMISSIONS.SUBJECT_MANAGE)
  assignClassSubject(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(classSubjectSchema)) body: z.infer<typeof classSubjectSchema>,
  ) {
    return this.lms.assignClassSubject(p, classId, body.subjectId, body.teacherId);
  }

  @Get("classes/:classId/subjects")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  classSubjects(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
  ): Promise<ClassSubjectDto[]> {
    return this.lms.listClassSubjects(p, classId);
  }

  @Post("classes/:classId/teachers")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_WRITE)
  assignTeacher(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(teacherSchema)) body: { teacherId: string },
  ) {
    return this.lms.assignTeacher(p, classId, body.teacherId);
  }

  @Post("classes/:classId/enrollments")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_WRITE)
  enroll(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(studentSchema)) body: { studentId: string },
  ) {
    return this.lms.enrollStudent(p, classId, body.studentId);
  }

  @Post("guardians")
  @RequirePermission(LMS_PERMISSIONS.GUARDIAN_WRITE)
  linkGuardian(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(guardianSchema)) body: { parentId: string; studentId: string },
  ) {
    return this.lms.linkGuardian(p, body.parentId, body.studentId);
  }

  /** Relationship-scoped: returns only classes the caller may see. */
  @Get("classes/mine")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  myClasses(@CurrentPrincipal() p: Principal): Promise<ClassDto[]> {
    return this.lms.listMyClasses(p);
  }

  /** Relationship-scoped student directory (id + name) for UI pickers. */
  @Get("students")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  students(@CurrentPrincipal() p: Principal): Promise<IdNameDto[]> {
    return this.lms.listStudents(p);
  }

  /** Staff user directory (id + name + roles) for admin pickers. class.write-gated. */
  @Get("users")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  users(@CurrentPrincipal() p: Principal): Promise<UserWithEmailDto[]> {
    return this.lms.listUsers(p);
  }

  @Get("classes/:classId")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_READ)
  roster(@CurrentPrincipal() p: Principal, @Param("classId") classId: string) {
    return this.lms.getClassRoster(p, classId);
  }

  /** Member-facing class info (subjects/teachers/supervisor) for parents/students. */
  @Get("classes/:classId/info")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  classInfo(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<ClassInfoDto> {
    return this.lms.getClassInfo(p, classId);
  }

  /** Promotion eligibility SIGNAL (avg score + attendance %) — staff only. */
  @Get("classes/:classId/eligibility")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_READ)
  eligibility(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<ClassEligibilityDto[]> {
    return this.lms.getClassEligibility(p, classId);
  }

  /** CSV export of a class roster (staff). */
  @Get("classes/:classId/roster.csv")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_READ)
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="class-roster.csv"')
  async rosterCsv(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<string> {
    const roster = await this.lms.getClassRoster(p, classId);
    const rows = (roster.students as Array<{ name: string; email: string }>).map(
      (s, i) => `${i + 1},"${s.name.replace(/"/g, '""')}",${s.email}`,
    );
    return `#,name,email\n${rows.join("\n")}\n`;
  }

  /** Transfer / withdraw / reactivate a student's enrollment (lifecycle). */
  @Put("classes/:classId/enrollments/:studentId/status")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_WRITE)
  setEnrollmentStatus(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(enrollStatusSchema)) body: z.infer<typeof enrollStatusSchema>,
  ) {
    return this.lms.setEnrollmentStatus(p, classId, studentId, body.status, body.reason);
  }

  // --- academic calendar (sessions + terms) ----------------------------------
  @Get("academic/sessions")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  sessions(@CurrentPrincipal() p: Principal): Promise<AcademicSessionDto[]> {
    return this.academic.listSessions(p);
  }

  @Post("academic/sessions")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  createSession(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(sessionSchema)) body: z.infer<typeof sessionSchema>,
  ) {
    return this.academic.createSession(p, body);
  }

  @Post("academic/sessions/:id/terms")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  addTerm(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(termSchema)) body: z.infer<typeof termSchema>,
  ) {
    return this.academic.addTerm(p, id, body);
  }

  @Put("academic/sessions/:id/current")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  setCurrentSession(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.academic.setCurrentSession(p, id);
  }

  @Put("academic/terms/:id/current")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  setCurrentTerm(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.academic.setCurrentTerm(p, id);
  }

  // --- end-of-session promotion (maker-checker) ------------------------------
  /** Stage a promotion batch (moves nothing until approved). Maker. */
  @Post("promotions")
  @RequirePermission(LMS_PERMISSIONS.CLASS_PROMOTE)
  stagePromotion(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(promotionSchema)) body: z.infer<typeof promotionSchema>,
  ): Promise<PromotionBatchDto> {
    return this.promotion.stage(p, body);
  }

  @Get("promotions")
  @RequirePermission(LMS_PERMISSIONS.CLASS_PROMOTE)
  promotions(@CurrentPrincipal() p: Principal): Promise<PromotionBatchDto[]> {
    return this.promotion.list(p);
  }

  @Get("promotions/:id")
  @RequirePermission(LMS_PERMISSIONS.CLASS_PROMOTE)
  getPromotion(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<PromotionBatchDto> {
    return this.promotion.get(p, id);
  }

  /** Approve a promotion batch — school_admin, a DIFFERENT person than the maker. */
  @Post("promotions/:id/approve")
  @RequirePermission(LMS_PERMISSIONS.CLASS_PROMOTE_APPROVE)
  approvePromotion(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
  ): Promise<PromotionBatchDto> {
    return this.promotion.approve(p, id);
  }

  @Post("promotions/:id/reject")
  @RequirePermission(LMS_PERMISSIONS.CLASS_PROMOTE_APPROVE)
  rejectPromotion(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(promoteRejectSchema)) body: z.infer<typeof promoteRejectSchema>,
  ): Promise<PromotionBatchDto> {
    return this.promotion.reject(p, id, body.note);
  }
}
