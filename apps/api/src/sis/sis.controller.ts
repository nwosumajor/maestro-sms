import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { ContactDto, MedicalRecordDto, StudentProfileDto } from "@sms/types";
import { z } from "zod";
import { SIS_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { SisService } from "./sis.service";

// All :studentId paths are relationship-scoped in the service (teacher-of-student
// / parent-of-child / self / school staff); the permission only gates the verb.
const nullableStr = z.string().max(2000).nullish();
const profileSchema = z.object({
  admissionNumber: nullableStr,
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  gender: nullableStr,
  phone: nullableStr,
  email: z.string().email().nullish(),
  addressLine1: nullableStr,
  addressLine2: nullableStr,
  city: nullableStr,
  state: nullableStr,
  country: nullableStr,
  postalCode: nullableStr,
  notes: nullableStr,
});
const contactSchema = z.object({
  name: z.string().min(1).max(200),
  relationship: z.string().min(1).max(100),
  phone: z.string().min(1).max(50),
  email: z.string().email().nullish(),
  priority: z.number().int().min(1).max(99).optional(),
});
const contactUpdateSchema = contactSchema.partial();
const medicalSchema = z.object({
  bloodGroup: nullableStr,
  allergies: nullableStr,
  conditions: nullableStr,
  medications: nullableStr,
  dietaryNotes: nullableStr,
  notes: nullableStr,
});

@RequireModule(MODULES.SIS)
@Controller("students/:studentId")
export class SisController {
  constructor(private readonly sis: SisService) {}

  // --- profile ---
  @Get("profile")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_PROFILE_READ)
  getProfile(@CurrentPrincipal() p: Principal, @Param("studentId") studentId: string): Promise<StudentProfileDto> {
    return this.sis.getProfile(p, studentId);
  }

  @Put("profile")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_PROFILE_WRITE)
  upsertProfile(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(profileSchema)) body: z.infer<typeof profileSchema>,
  ) {
    return this.sis.upsertProfile(p, studentId, body);
  }

  // --- emergency contacts ---
  @Get("contacts")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_CONTACT_READ)
  listContacts(@CurrentPrincipal() p: Principal, @Param("studentId") studentId: string): Promise<ContactDto[]> {
    return this.sis.listContacts(p, studentId);
  }

  @Post("contacts")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_CONTACT_WRITE)
  addContact(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(contactSchema)) body: z.infer<typeof contactSchema>,
  ) {
    return this.sis.addContact(p, studentId, body);
  }

  @Patch("contacts/:contactId")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_CONTACT_WRITE)
  updateContact(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Param("contactId") contactId: string,
    @Body(new ZodValidationPipe(contactUpdateSchema)) body: z.infer<typeof contactUpdateSchema>,
  ) {
    return this.sis.updateContact(p, studentId, contactId, body);
  }

  @Delete("contacts/:contactId")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_CONTACT_WRITE)
  removeContact(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Param("contactId") contactId: string,
  ) {
    return this.sis.removeContact(p, studentId, contactId);
  }

  // --- medical (read + write both audited in the service) ---
  @Get("medical")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_MEDICAL_READ)
  getMedical(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
  ): Promise<MedicalRecordDto | null> {
    return this.sis.getMedical(p, studentId);
  }

  @Put("medical")
  @RequirePermission(SIS_PERMISSIONS.STUDENT_MEDICAL_WRITE)
  @RequireStepUp()
  upsertMedical(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(medicalSchema)) body: z.infer<typeof medicalSchema>,
  ) {
    return this.sis.upsertMedical(p, studentId, body);
  }
}
