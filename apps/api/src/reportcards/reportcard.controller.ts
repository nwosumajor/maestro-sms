import { Body, Controller, Get, Param, Post, Put, Query, Res, StreamableFile } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { Response } from "express";
import { z } from "zod";
import { GRADEBOOK_PERMISSIONS } from "@sms/types";
import type { ReportCardRemarkDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { StudentTraitService } from "./student-trait.service";
import { TRAIT_SCORE_MAX, TRAIT_SCORE_MIN, type StudentTraitsDto } from "@sms/types";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { ReportCardService } from "./reportcard.service";
import { ReportCardRemarkService } from "./report-card-remark.service";

const remarkSchema = z.object({ termId: z.string().uuid(), remark: z.string().min(1).max(2000) });

// The whole set in one submission: twenty separate requests would be twenty
// audit rows for one act, and a half-saved set reads as a judgement rather than
// an interruption. Keys are validated against the catalogue in the service.
const traitsSchema = z.object({
  termId: z.string().uuid(),
  ratings: z
    .array(z.object({ traitKey: z.string().min(1).max(60), score: z.number().int().min(TRAIT_SCORE_MIN).max(TRAIT_SCORE_MAX) }))
    .min(1)
    .max(60),
});

// GRADEBOOK, not DOCUMENTS.
//
// A report card is the gradebook's OUTPUT. Gating it on the vault it happens to
// be filed in meant a school with GRADEBOOK could record marks all term and not
// print a report — the input included and the output withheld. The vault write
// is best-effort and stays that way: a school without DOCUMENTS still gets the
// PDF, it just does not get a stored copy to re-download.
@RequireModule(MODULES.GRADEBOOK)
@Controller("reportcards")
export class ReportCardController {
  constructor(
    private readonly reportcards: ReportCardService,
    private readonly remarks: ReportCardRemarkService,
    private readonly traits: StudentTraitService,
  ) {}

  /** Generate + download a student's report card PDF (optionally for a term,
   *  which pulls in that term's class-teacher and head remarks). */
  @Post(":studentId/generate")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  async generate(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Res({ passthrough: true }) res: Response,
    @Query("termId") termId?: string,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.reportcards.generate(p, studentId, termId);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  /** Read a student's remarks for a term (report-card scope). */
  @Get(":studentId/remarks")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  getRemarks(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Query("termId") termId: string,
  ): Promise<ReportCardRemarkDto> {
    return this.remarks.get(p, studentId, termId);
  }

  /** Class teacher (or staff-wide) writes the class-teacher remark. */
  @Put(":studentId/remarks/class-teacher")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_WRITE)
  setClassTeacherRemark(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(remarkSchema)) body: z.infer<typeof remarkSchema>,
  ): Promise<ReportCardRemarkDto> {
    return this.remarks.setClassTeacherRemark(p, studentId, body.termId, body.remark);
  }

  /** Principal / school admin writes the head remark. */
  @Put(":studentId/remarks/head")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  setHeadRemark(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(remarkSchema)) body: z.infer<typeof remarkSchema>,
  ): Promise<ReportCardRemarkDto> {
    return this.remarks.setHeadRemark(p, studentId, body.termId, body.remark);
  }

  /**
   * A pupil's behavioural / psychomotor ratings for a term.
   *
   * Gated on the coarse grade.read, like the remarks beside it; the SERVICE
   * decides who may actually see them — the pupil, their guardians, the staff
   * who teach them — and 404s everyone else.
   */
  @Get(":studentId/traits")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  getTraits(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Query("termId") termId: string,
  ): Promise<StudentTraitsDto> {
    return this.traits.getTraits(p, studentId, termId);
  }

  /** The class teacher (or staff-wide) records the whole set in one act. */
  @Put(":studentId/traits")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_WRITE)
  setTraits(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(traitsSchema)) body: z.infer<typeof traitsSchema>,
  ): Promise<StudentTraitsDto> {
    return this.traits.setTraits(p, studentId, body.termId, body.ratings);
  }

  /** Every pupil in a class with their ratings — what the entry grid reads. */
  @Get("classes/:classId/traits")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_WRITE)
  classTraits(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Query("termId") termId: string,
  ) {
    return this.traits.classTraits(p, classId, termId);
  }
}
