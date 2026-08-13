// =============================================================================
// The year-archive surface: produce one, list them, fetch one back.
// =============================================================================
// STEP-UP ON ALL THREE, including the read. An archive is the whole institution
// for a year in one downloadable object — every pupil's file plus staff records
// and decrypted salaries. Everywhere else a read is cheaper than a write; here
// the download IS the sensitive act, so it is gated exactly as hard as creation.
// =============================================================================

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { PRIVACY_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { SchoolArchiveService, type ArchiveSummary } from "./archive.service";
import { JobRunsService } from "../maintenance/job-runs.service";

const createSchema = z.object({
  /** e.g. "2025/2026" — how a human will look for it in ten years. */
  label: z.string().min(1).max(80),
  sessionId: z.string().uuid().optional(),
});

@Controller("privacy/archives")
export class SchoolArchiveController {
  constructor(private readonly archives: SchoolArchiveService, private readonly jobRuns: JobRunsService) {}

  /** The archives this school holds. Metadata and counts only. */
  @Get()
  @RequirePermission(PRIVACY_PERMISSIONS.ARCHIVE_MANAGE)
  list(@CurrentPrincipal() p: Principal): Promise<ArchiveSummary[]> {
    return this.archives.list(p);
  }

  /** Produce this year's archive. */
  @Post()
  @RequirePermission(PRIVACY_PERMISSIONS.ARCHIVE_MANAGE)
  @RequireStepUp()
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<ArchiveSummary> {
    return this.archives.create(p, body);
  }

  /** Run the term sweep now — for an operator verifying it, or catching up after
   *  an outage. Idempotent: a term already archived is skipped by the database. */
  @Post("run-term-sweep")
  @RequirePermission(PRIVACY_PERMISSIONS.ARCHIVE_MANAGE)
  @RequireStepUp()
  runTermSweep(): Promise<{ scanned: number; archived: number; skipped: number }> {
    return this.jobRuns.record("privacy.archive", "MANUAL", () =>
      this.archives.archiveEndedTerms("MANUAL"),
    );
  }

  /**
   * A time-limited link to the archive body, plus the checksum recorded when it
   * was made — so whoever receives it can prove the bytes were not altered in
   * the years between.
   */
  @Post(":id/download")
  @RequirePermission(PRIVACY_PERMISSIONS.ARCHIVE_MANAGE)
  @RequireStepUp()
  download(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<{ url: string; checksum: string }> {
    return this.archives.download(p, id);
  }
}
