import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { MODULES, HR_PERMISSIONS } from "@sms/types";
import type { ApplicantDto, JobRequisitionDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { Public } from "../auth/public.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { RecruitmentService } from "./recruitment.service";

const reqSchema = z.object({
  title: z.string().min(1).max(160),
  department: z.string().max(120).nullish(),
  description: z.string().max(4000).nullish(),
  openings: z.number().int().min(1).max(999).optional(),
});
const reqStatusSchema = z.object({ status: z.enum(["DRAFT", "OPEN", "CLOSED", "FILLED"]) });
const applicantSchema = z.object({
  name: z.string().min(1).max(160),
  email: z.string().email(),
  phone: z.string().max(40).nullish(),
  notes: z.string().max(2000).nullish(),
});
const stageSchema = z.object({ stage: z.enum(["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"]) });
const convertSchema = z.object({ jobTitle: z.string().max(120).optional(), password: z.string().min(8).max(200).optional() });
const MAX_CV_BYTES = 5 * 1024 * 1024; // 5 MB

/** Multer file (typed inline — no @types/multer dependency). */
interface UploadedCv {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

const publicApplySchema = z.object({
  requisitionId: z.string().uuid(),
  name: z.string().min(1).max(160),
  email: z.string().email().max(200),
  phone: z.string().max(40).optional(),
  note: z.string().max(2000).optional(),
});

@RequireModule(MODULES.HR)
@Controller("hr/recruitment")
export class RecruitmentController {
  constructor(private readonly recruit: RecruitmentService) {}

  /** Download an applicant's CV (PII — audited server-side). */
  @Get("applicants/:id/cv")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  async cv(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.recruit.downloadCv(p, id);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"` });
    return new StreamableFile(buffer);
  }

  @Post("requisitions")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  createReq(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(reqSchema)) body: z.infer<typeof reqSchema>,
  ): Promise<JobRequisitionDto> {
    return this.recruit.createRequisition(p, body);
  }

  @Get("requisitions")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  listReqs(@CurrentPrincipal() p: Principal): Promise<JobRequisitionDto[]> {
    return this.recruit.listRequisitions(p);
  }

  @Post("requisitions/:id/status")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  setReqStatus(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(reqStatusSchema)) body: z.infer<typeof reqStatusSchema>,
  ): Promise<JobRequisitionDto> {
    return this.recruit.setRequisitionStatus(p, id, body.status);
  }

  @Post("requisitions/:id/applicants")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  addApplicant(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(applicantSchema)) body: z.infer<typeof applicantSchema>,
  ): Promise<ApplicantDto> {
    return this.recruit.addApplicant(p, id, body);
  }

  @Get("applicants")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  listApplicants(@CurrentPrincipal() p: Principal, @Query("requisitionId") requisitionId?: string): Promise<ApplicantDto[]> {
    return this.recruit.listApplicants(p, requisitionId);
  }

  @Post("applicants/:id/stage")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  moveStage(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(stageSchema)) body: z.infer<typeof stageSchema>,
  ): Promise<ApplicantDto> {
    return this.recruit.moveStage(p, id, body.stage);
  }

  /** Convert a hired applicant into a staff account (creates credentials → step-up). */
  @Post("applicants/:id/convert")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  @RequireStepUp()
  convert(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(convertSchema)) body: z.infer<typeof convertSchema>,
  ): Promise<{ userId: string; email: string; tempPassword: string }> {
    return this.recruit.convert(p, id, body);
  }
}

// PUBLIC careers surface — its OWN controller so the routes live at /public/*
// (outside the hr/recruitment prefix and its module gate). Quarantined intake,
// same posture as /public/admissions: rate-limited write, no auth, no PII out.
@Controller("public/careers")
export class PublicCareersController {
  constructor(private readonly recruit: RecruitmentService) {}

  @Public()
  @Get(":slug")
  openings(@Param("slug") slug: string) {
    return this.recruit.publicOpenings(slug);
  }

  @Public()
  @UseGuards(new RateLimitGuard(10, 60_000))
  @Post(":slug/apply")
  // Optional CV: multipart field "cv", PDF only, hard 5 MB cap enforced by
  // multer BEFORE the body reaches us (an oversized upload 413s early). JSON
  // bodies (no file) pass straight through the interceptor untouched.
  @UseInterceptors(
    FileInterceptor("cv", {
      limits: { fileSize: MAX_CV_BYTES, files: 1 },
      fileFilter: (_req, file, cb) =>
        file.mimetype === "application/pdf" ? cb(null, true) : cb(new BadRequestException("The CV must be a PDF file"), false),
    }),
  )
  apply(
    @Param("slug") slug: string,
    @Body(new ZodValidationPipe(publicApplySchema)) b: z.infer<typeof publicApplySchema>,
    @UploadedFile() cv?: UploadedCv,
  ) {
    return this.recruit.publicApply(slug, b, cv ?? null);
  }
}
