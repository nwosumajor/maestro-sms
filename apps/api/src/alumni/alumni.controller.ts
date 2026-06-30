import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import { ALUMNI_PERMISSIONS } from "@sms/types";
import { MODULES } from "@sms/types";
import type { AlumnusDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { AlumniService } from "./alumni.service";

const baseSchema = {
  name: z.string().min(1).max(200),
  email: z.string().email().nullish(),
  phone: z.string().max(40).nullish(),
  graduationYear: z.number().int().min(1900).max(2200).nullish(),
  lastClass: z.string().max(80).nullish(),
  occupation: z.string().max(160).nullish(),
  notes: z.string().max(2000).nullish(),
};
const createSchema = z.object({ ...baseSchema, userId: z.string().uuid().nullish() });
const updateSchema = z.object(baseSchema).partial();
const broadcastSchema = z.object({ title: z.string().min(1).max(160), body: z.string().min(1).max(2000), year: z.number().int().nullish() });

@RequireModule(MODULES.ALUMNI)
@Controller("alumni")
export class AlumniController {
  constructor(private readonly alumni: AlumniService) {}

  @Get()
  @RequirePermission(ALUMNI_PERMISSIONS.ALUMNI_MANAGE)
  list(@CurrentPrincipal() p: Principal, @Query("year") year?: string, @Query("q") q?: string): Promise<AlumnusDto[]> {
    return this.alumni.list(p, { year: year ? Number(year) : undefined, q });
  }

  @Post()
  @RequirePermission(ALUMNI_PERMISSIONS.ALUMNI_MANAGE)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(createSchema)) b: z.infer<typeof createSchema>): Promise<AlumnusDto> {
    return this.alumni.create(p, b);
  }

  @Put(":id")
  @RequirePermission(ALUMNI_PERMISSIONS.ALUMNI_MANAGE)
  update(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(updateSchema)) b: z.infer<typeof updateSchema>): Promise<AlumnusDto> {
    return this.alumni.update(p, id, b);
  }

  @Post("broadcast")
  @RequirePermission(ALUMNI_PERMISSIONS.ALUMNI_MANAGE)
  broadcast(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(broadcastSchema)) b: z.infer<typeof broadcastSchema>) {
    return this.alumni.broadcast(p, { title: b.title, body: b.body, year: b.year ?? undefined });
  }
}
