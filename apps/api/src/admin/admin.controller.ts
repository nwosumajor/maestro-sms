import { Body, Controller, Delete, Get, Header, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { ADMIN_PERMISSIONS, LMS_PERMISSIONS, SIS_PERMISSIONS } from "@sms/types";
import type { StudentImportBatchDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { AdminService } from "./admin.service";
import { StudentImportService } from "./student-import.service";

const roleSchema = z.object({ roleName: z.string().min(1).max(40) });
const createUserSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  role: z.string().min(1).max(40),
  password: z.string().min(8).max(200).optional(),
});
const importSchema = z.object({
  rows: z
    .array(z.object({ name: z.string().min(1).max(200), email: z.string().email(), classId: z.string().uuid().nullish() }))
    .min(1)
    .max(500),
});
const sisRowSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  admissionNumber: z.string().max(60).nullish(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  gender: z.string().max(20).nullish(),
  phone: z.string().max(40).nullish(),
  address: z.string().max(400).nullish(),
  classId: z.string().uuid().nullish(),
});
const sisImportSchema = z.object({ rows: z.array(sisRowSchema).min(1).max(1000) });
const rejectSchema = z.object({ note: z.string().max(1000).optional() });

@Controller("admin")
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly studentImport: StudentImportService,
  ) {}

  @Get("roles")
  @RequirePermission(ADMIN_PERMISSIONS.RBAC_MANAGE)
  roles(@CurrentPrincipal() p: Principal) {
    return this.admin.listRoles(p);
  }

  /** List this school's users (directory / staff picker). */
  @Get("users")
  @RequirePermission(ADMIN_PERMISSIONS.RBAC_MANAGE)
  users(@CurrentPrincipal() p: Principal) {
    return this.admin.listUsers(p);
  }

  /** Create a profile (any non-super_admin role) within the caller's own school. */
  @Post("users")
  @RequirePermission(ADMIN_PERMISSIONS.RBAC_MANAGE)
  createUser(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createUserSchema)) body: z.infer<typeof createUserSchema>,
  ) {
    return this.admin.createUser(p, body);
  }

  @Post("users/:userId/roles")
  @RequirePermission(ADMIN_PERMISSIONS.RBAC_MANAGE)
  assign(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(roleSchema)) body: { roleName: string },
  ) {
    return this.admin.assignRole(p, userId, body.roleName);
  }

  @Delete("users/:userId/roles/:roleName")
  @RequirePermission(ADMIN_PERMISSIONS.RBAC_MANAGE)
  remove(@CurrentPrincipal() p: Principal, @Param("userId") userId: string, @Param("roleName") roleName: string) {
    return this.admin.removeRole(p, userId, roleName);
  }

  /** Bulk-create students (CSV parsed client-side into rows). Legacy thin import. */
  @Post("import/students")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  importStudents(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(importSchema)) body: z.infer<typeof importSchema>,
  ) {
    return this.admin.importStudents(p, body.rows);
  }

  // --- bulk SIS import with maker-checker -----------------------------------
  /** Download the CSV SIS template (header + example row). */
  @Get("students/import/template")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_IMPORT)
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="sis-import-template.csv"')
  importTemplate(): string {
    return this.studentImport.csvTemplate();
  }

  /** Stage a PENDING SIS batch (creates nothing yet; returns a dry-run summary). */
  @Post("students/import")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_IMPORT)
  stageImport(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(sisImportSchema)) body: z.infer<typeof sisImportSchema>,
  ): Promise<StudentImportBatchDto> {
    return this.studentImport.stage(p, body.rows);
  }

  @Get("students/import")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_IMPORT)
  listImports(@CurrentPrincipal() p: Principal): Promise<StudentImportBatchDto[]> {
    return this.studentImport.list(p);
  }

  @Get("students/import/:id")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_IMPORT)
  getImport(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<StudentImportBatchDto> {
    return this.studentImport.get(p, id);
  }

  /** Approve a PENDING batch — a DIFFERENT person than the uploader (SoD). */
  @Post("students/import/:id/approve")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_IMPORT)
  approveImport(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<StudentImportBatchDto> {
    return this.studentImport.approve(p, id);
  }

  @Post("students/import/:id/reject")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_IMPORT)
  rejectImport(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: z.infer<typeof rejectSchema>,
  ): Promise<StudentImportBatchDto> {
    return this.studentImport.reject(p, id, body.note);
  }
}
