import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { ADMIN_PERMISSIONS, LMS_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { AdminService } from "./admin.service";

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

@Controller("admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

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

  /** Bulk-create students (CSV parsed client-side into rows). */
  @Post("import/students")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  importStudents(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(importSchema)) body: z.infer<typeof importSchema>,
  ) {
    return this.admin.importStudents(p, body.rows);
  }
}
