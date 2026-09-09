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
import { OPERATOR_PERMISSIONS, PRIVACY_PERMISSIONS } from "@sms/types";
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
  /** Bound the archive to one academic session. Omit BOTH for a whole-school
   *  export — what a school leaving, or taking a full backup, wants. */
  sessionId: z.string().uuid().optional(),
  /**
   * Bound it to one TERM, which is narrower and is what the nightly sweep
   * uses.
   *
   * // GOTCHA: the sweep passed `termId` from the day it was written and the
   * HTTP schema never accepted it, so it was silently dropped from every
   * hand-made archive — a term could only ever be archived by the timer, and
   * asking for one by hand quietly widened to the session.
   */
  termId: z.string().uuid().optional(),
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
  // EITHER door: the school's own officer (their school), or a platform
  // operator (the fleet). Before this the operator — the one person the jobs
  // console is built for — was 403'd on their own console's button, because the
  // route asked for a permission only a school role holds.
  @RequirePermission(PRIVACY_PERMISSIONS.ARCHIVE_MANAGE, OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  // NO step-up, unlike `create` and `download` beside it, and the difference is
  // the point. This asks for the archives the NIGHTLY TIMER would take anyway,
  // unattended, of terms that have already ended — it discloses nothing and
  // chooses nothing. The sensitive acts are taking an arbitrary archive
  // (`POST /privacy/archives`) and reading its bytes (`:id/download`), and both
  // keep their step-up. Requiring re-authentication to ask a machine to do
  // tonight's work early is friction with nothing behind it — and, since this
  // route also admits `platform.operate`, it would have pulled seven unrelated
  // operator sweeps into needing step-up by consistency.
  runTermSweep(@CurrentPrincipal() p: Principal): Promise<{ scanned: number; archived: number; skipped: number }> {
    // THE CALLER'S SCHOOL, unless the caller is a platform operator.
    // `privacy.archive.manage` belongs to principal and school_admin, and this
    // ran the fleet: one demo principal's press wrote 500 permanent archives
    // into 500 other schools. The nightly sweep still covers everyone.
    const fleet = p.permissions.includes(OPERATOR_PERMISSIONS.PLATFORM_OPERATE);
    return this.jobRuns.record("privacy.archive", "MANUAL", () =>
      this.archives.archiveEndedTerms("MANUAL", fleet ? undefined : p.schoolId),
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
