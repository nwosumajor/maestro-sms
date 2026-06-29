import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { ClassDto, ClassSubjectDto, IdNameDto, PromotionBatchDto, SubjectDto, UserWithEmailDto } from "@sms/types";
import { z } from "zod";
import { LMS_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { LmsService } from "./lms.service";
import { PromotionService } from "./promotion.service";

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
});
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
