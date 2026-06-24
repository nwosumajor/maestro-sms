import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { ClassDto, IdNameDto, UserWithEmailDto } from "@sms/types";
import { z } from "zod";
import { LMS_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { LmsService } from "./lms.service";

const createClassSchema = z.object({ name: z.string().min(1), subject: z.string().optional() });
const teacherSchema = z.object({ teacherId: z.string().uuid() });
const studentSchema = z.object({ studentId: z.string().uuid() });
const guardianSchema = z.object({ parentId: z.string().uuid(), studentId: z.string().uuid() });

@RequireModule(MODULES.LMS)
@Controller()
export class LmsController {
  constructor(private readonly lms: LmsService) {}

  @Post("classes")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  createClass(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createClassSchema)) body: { name: string; subject?: string },
  ) {
    return this.lms.createClass(p, body);
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
}
