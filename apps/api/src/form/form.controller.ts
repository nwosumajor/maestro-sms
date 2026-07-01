import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { FORM_PERMISSIONS, MODULES } from "@sms/types";
import type { FormDto, FormResponseDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { FormService } from "./form.service";

const fieldSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  type: z.enum(["text", "textarea", "number", "select", "rating"]),
  options: z.array(z.string().max(120)).optional(),
  required: z.boolean().optional(),
});
const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  fields: z.array(fieldSchema).min(1).max(50),
  audience: z.enum(["ALL", "STUDENTS", "STAFF"]).default("ALL"),
  anonymous: z.boolean().optional(),
});
const respondSchema = z.object({ answers: z.record(z.union([z.string(), z.number()])) });

@RequireModule(MODULES.FORM)
@Controller("forms")
export class FormController {
  constructor(private readonly forms: FormService) {}

  @Get()
  @RequirePermission(FORM_PERMISSIONS.FORM_RESPOND)
  list(@CurrentPrincipal() p: Principal): Promise<FormDto[]> {
    return this.forms.listForms(p);
  }

  @Post()
  @RequirePermission(FORM_PERMISSIONS.FORM_MANAGE)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(createSchema)) b: z.infer<typeof createSchema>): Promise<FormDto> {
    return this.forms.createForm(p, b);
  }

  @Post(":id/close")
  @RequirePermission(FORM_PERMISSIONS.FORM_MANAGE)
  close(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<FormDto> {
    return this.forms.closeForm(p, id);
  }

  @Post(":id/respond")
  @RequirePermission(FORM_PERMISSIONS.FORM_RESPOND)
  respond(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(respondSchema)) b: z.infer<typeof respondSchema>): Promise<FormDto> {
    return this.forms.respond(p, id, b.answers);
  }

  @Get(":id/responses")
  @RequirePermission(FORM_PERMISSIONS.FORM_MANAGE)
  responses(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<FormResponseDto[]> {
    return this.forms.responses(p, id);
  }
}
