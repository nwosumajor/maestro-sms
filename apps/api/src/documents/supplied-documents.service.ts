// =============================================================================
// Documents a school asks somebody for — requirements, and what came back
// =============================================================================
// Step 2 and 3 of the module: the school's list, and the submissions filed
// against it. Both flows — a family at admission, a candidate at hire — run
// through here, because the shape is identical and a second implementation is
// how the two drift.
//
// AUTHORITY IS SPLIT BY SCOPE, and deliberately reuses permissions that already
// exist rather than minting new ones (a new permission needs the seed re-run
// against every live database before the endpoint works at all):
//
//   STUDENT_ADMISSION -> student.profile.write   (principal / school_admin / junior_admin)
//   STAFF_ONBOARDING  -> hr.write                (principal / school_admin / hr_clerk / hr_manager)
//
// The controller gates coarsely on document.write, which is staff-only; this
// narrows it to the people whose job the paperwork actually is. An HR clerk has
// no business verifying a pupil's birth certificate, and a registrar none
// verifying a teacher's licence.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  MAX_UPLOAD_BYTES,
  REQUIREMENT_SCOPES,
  SUBMISSION_SUBJECTS,
  defaultRequirements,
  outstandingRequirements,
  submissionProgress,
  type DocumentRequirementDto,
  type DocumentSubmissionDto,
  type RequirementScope,
  type SubmissionChecklistDto,
  type SubmissionStatus,
  type SubmissionSubject,
  type UploadTicketDto,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { STORAGE_PROVIDER, type StorageProvider } from "./storage.provider";
import { baseContentType, isAcceptedUploadType, sniffUploadType } from "./sniff-upload";

/** Which half of the school a subject belongs to. */
const SCOPE_OF_SUBJECT: Record<SubmissionSubject, RequirementScope> = {
  ADMISSION_APPLICATION: "STUDENT_ADMISSION",
  STUDENT: "STUDENT_ADMISSION",
  APPLICANT: "STAFF_ONBOARDING",
  STAFF: "STAFF_ONBOARDING",
};

const PERMISSION_OF_SCOPE: Record<RequirementScope, string> = {
  STUDENT_ADMISSION: "student.profile.write",
  STAFF_ONBOARDING: "hr.write",
};

type RequirementRow = {
  id: string;
  appliesTo: string;
  key: string;
  label: string;
  description: string | null;
  mandatory: boolean;
  needsExpiry: boolean;
  sequence: number;
  active: boolean;
};

type SubmissionRow = {
  id: string;
  requirementId: string | null;
  storageKey: string | null;
  originalName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  status: string;
  uploadedByUserId: string | null;
  uploadedAt: Date | null;
  verifiedById: string | null;
  verifiedAt: Date | null;
  rejectedReason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  subjectKind: string;
  subjectId: string;
};

@Injectable()
export class SuppliedDocumentsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private assertScope(scope: string): asserts scope is RequirementScope {
    if (!(REQUIREMENT_SCOPES as readonly string[]).includes(scope)) {
      throw new BadRequestException("Unknown requirement scope");
    }
  }

  private assertSubject(kind: string): asserts kind is SubmissionSubject {
    if (!(SUBMISSION_SUBJECTS as readonly string[]).includes(kind)) {
      throw new BadRequestException("Unknown subject kind");
    }
  }

  /** May this person manage/decide paperwork on THIS side of the school? */
  private assertMayManage(p: Principal, scope: RequirementScope): void {
    if (!p.permissions.includes(PERMISSION_OF_SCOPE[scope])) {
      throw new ForbiddenException(
        scope === "STUDENT_ADMISSION"
          ? "Managing pupil admission documents needs student.profile.write"
          : "Managing staff onboarding documents needs hr.write",
      );
    }
  }

  // --- requirements: what this school asks for -------------------------------

  async listRequirements(p: Principal, scope: string): Promise<DocumentRequirementDto[]> {
    this.assertScope(scope);
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await this.requirementsInTx(tx, scope, { includeInactive: true });
      return rows.map((r) => this.toRequirementDto(r));
    });
  }

  private async requirementsInTx(
    tx: TenantTx,
    scope: RequirementScope,
    opts: { includeInactive?: boolean } = {},
  ): Promise<RequirementRow[]> {
    return (await tx.documentRequirement.findMany({
      where: { appliesTo: scope, ...(opts.includeInactive ? {} : { active: true }) },
      orderBy: [{ sequence: "asc" }, { label: "asc" }],
    })) as RequirementRow[];
  }

  async createRequirement(
    p: Principal,
    input: { appliesTo: string; key: string; label: string; description?: string; mandatory?: boolean; needsExpiry?: boolean; sequence?: number },
  ): Promise<DocumentRequirementDto> {
    this.assertScope(input.appliesTo);
    this.assertMayManage(p, input.appliesTo);
    const key = input.key.trim().toLowerCase();
    if (!/^[a-z0-9_]{2,60}$/.test(key)) {
      throw new BadRequestException("A requirement key is 2–60 characters of a–z, 0–9 and underscore");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // The unique index is the real guard against a duplicate key; this exists
      // to answer with something a person can act on rather than a 409 from a
      // constraint name.
      const clash = await tx.documentRequirement.findFirst({
        where: { appliesTo: input.appliesTo, key },
        select: { id: true },
      });
      if (clash) throw new BadRequestException(`This school already asks for "${key}"`);
      const row = (await tx.documentRequirement.create({
        data: {
          schoolId: p.schoolId,
          appliesTo: input.appliesTo,
          key,
          label: input.label.trim(),
          description: input.description?.trim() || null,
          mandatory: input.mandatory ?? false,
          needsExpiry: input.needsExpiry ?? false,
          sequence: input.sequence ?? 0,
          createdById: p.userId,
        },
      })) as RequirementRow;
      await this.audit.record(
        {
          actorId: p.userId,
          action: "document.requirement.create",
          entity: "document_requirement",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { appliesTo: input.appliesTo, key, mandatory: row.mandatory },
        },
        tx,
      );
      return this.toRequirementDto(row);
    });
  }

  async updateRequirement(
    p: Principal,
    id: string,
    patch: { label?: string; description?: string | null; mandatory?: boolean; needsExpiry?: boolean; sequence?: number; active?: boolean },
  ): Promise<DocumentRequirementDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = (await tx.documentRequirement.findFirst({ where: { id } })) as RequirementRow | null;
      // 404, not 403 — never confirm that another school's requirement exists.
      if (!existing) throw new NotFoundException("Requirement not found");
      this.assertScope(existing.appliesTo);
      this.assertMayManage(p, existing.appliesTo);
      const row = (await tx.documentRequirement.update({
        where: { id },
        data: {
          ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
          ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
          ...(patch.mandatory !== undefined ? { mandatory: patch.mandatory } : {}),
          ...(patch.needsExpiry !== undefined ? { needsExpiry: patch.needsExpiry } : {}),
          ...(patch.sequence !== undefined ? { sequence: patch.sequence } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
        },
      })) as RequirementRow;
      await this.audit.record(
        {
          actorId: p.userId,
          action: "document.requirement.update",
          entity: "document_requirement",
          entityId: id,
          schoolId: p.schoolId,
          metadata: { key: existing.key, ...patch },
        },
        tx,
      );
      return this.toRequirementDto(row);
    });
  }

  /**
   * Adopt the platform's starting list.
   *
   * IDEMPOTENT on the key: a school that already asks for a birth certificate
   * keeps its own wording, its own mandatory flag and its own position. Running
   * this twice must never duplicate a requirement or quietly undo an edit — the
   * button exists to fill an empty list, not to reset a curated one.
   */
  async seedDefaults(p: Principal, scope: string): Promise<{ created: number; existing: number }> {
    this.assertScope(scope);
    this.assertMayManage(p, scope);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const have = new Set(
        ((await tx.documentRequirement.findMany({
          where: { appliesTo: scope },
          select: { key: true },
        })) as Array<{ key: string }>).map((r) => r.key),
      );
      const seeds = defaultRequirements(scope).filter((s) => !have.has(s.key));
      let sequence = have.size;
      for (const seed of seeds) {
        await tx.documentRequirement.create({
          data: {
            schoolId: p.schoolId,
            appliesTo: scope,
            key: seed.key,
            label: seed.label,
            description: seed.description,
            mandatory: seed.mandatory,
            needsExpiry: seed.needsExpiry,
            sequence: sequence++,
            createdById: p.userId,
          },
        });
      }
      if (seeds.length > 0) {
        await this.audit.record(
          {
            actorId: p.userId,
            action: "document.requirement.seed_defaults",
            entity: "document_requirement",
            entityId: p.schoolId,
            schoolId: p.schoolId,
            metadata: { appliesTo: scope, created: seeds.map((s) => s.key) },
          },
          tx,
        );
      }
      return { created: seeds.length, existing: have.size };
    });
  }

  // --- submissions: what came back -------------------------------------------

  /** Everything one screen needs: the list, what arrived, and what is missing. */
  async checklist(p: Principal, subjectKind: string, subjectId: string): Promise<SubmissionChecklistDto> {
    this.assertSubject(subjectKind);
    const scope = SCOPE_OF_SUBJECT[subjectKind];
    this.assertMayManage(p, scope);
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const requirements = await this.requirementsInTx(tx, scope);
      const submissions = (await tx.documentSubmission.findMany({
        where: { subjectKind, subjectId },
        orderBy: { createdAt: "asc" },
      })) as SubmissionRow[];
      const names = await this.namesFor(tx, submissions.map((s) => s.verifiedById));
      const labelOf = new Map(requirements.map((r) => [r.id, r.label] as const));
      return {
        subjectKind,
        subjectId,
        requirements: requirements.map((r) => this.toRequirementDto(r)),
        submissions: submissions.map((s) => this.toSubmissionDto(s, labelOf, names)),
        outstanding: outstandingRequirements(
          requirements,
          submissions.map((s) => ({ requirementId: s.requirementId, status: s.status as SubmissionStatus })),
        ).map((r) => this.toRequirementDto(r)),
        progress: submissionProgress(
          requirements,
          submissions.map((s) => ({ requirementId: s.requirementId, status: s.status as SubmissionStatus })),
        ),
      };
    });
  }

  /**
   * Hand out a presigned PUT and the row it will be confirmed against.
   *
   * The row is written FIRST, PENDING. The bytes travel browser→bucket where the
   * API cannot see them, so without a row beforehand there is nothing to confirm
   * against and an upload that half-completes leaves an object nothing knows
   * about. The same reasoning as the Vault's own upload, and as the mobile-money
   * intent: write what you expect before you ask for it.
   */
  async startUpload(
    p: Principal,
    input: { subjectKind: string; subjectId: string; requirementId?: string | null; filename: string; contentType: string },
  ): Promise<UploadTicketDto> {
    this.assertSubject(input.subjectKind);
    this.assertMayManage(p, SCOPE_OF_SUBJECT[input.subjectKind]);
    if (!isAcceptedUploadType(input.contentType)) {
      throw new BadRequestException("Upload a PDF, JPEG or PNG");
    }
    const contentType = baseContentType(input.contentType);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (input.requirementId) await this.requireRequirement(tx, input.requirementId, input.subjectKind as SubmissionSubject);
      const id = randomUUID();
      const storageKey = `schools/${p.schoolId}/submissions/${id}`;
      await tx.documentSubmission.create({
        data: {
          id,
          schoolId: p.schoolId,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          requirementId: input.requirementId ?? null,
          storageKey,
          contentType,
          originalName: input.filename.slice(0, 200),
          status: "PENDING",
          uploadedByUserId: p.userId,
        },
      });
      const presigned = await this.storage.presignUpload({ key: storageKey, contentType });
      return {
        submissionId: id,
        uploadUrl: presigned.url,
        expiresInSeconds: presigned.expiresInSeconds,
        maxBytes: MAX_UPLOAD_BYTES,
      };
    });
  }

  /**
   * The upload says it finished. Check.
   *
   * Three things are settled here, and none of them can be settled earlier:
   * that an object exists at all, that it is within the size cap, and that its
   * BYTES are the type it claimed. A content type is a claim by the uploader —
   * here, a member of the public — and the presigned PUT went straight to the
   * bucket, so this is the first and only moment the API can look.
   */
  async confirmUpload(p: Principal, id: string): Promise<DocumentSubmissionDto> {
    const row = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) =>
      (await tx.documentSubmission.findFirst({ where: { id } })) as SubmissionRow | null,
    );
    if (!row) throw new NotFoundException("Submission not found");
    this.assertSubject(row.subjectKind);
    this.assertMayManage(p, SCOPE_OF_SUBJECT[row.subjectKind]);
    if (row.status !== "PENDING") throw new BadRequestException("This upload has already been confirmed");
    if (!row.storageKey) throw new BadRequestException("This submission has no file to confirm");

    const bytes = await this.storage.download(row.storageKey);
    // Absent bytes are the ordinary failure — a browser closed mid-upload — and
    // must leave the row PENDING so the same ticket can be used again.
    if (!bytes) throw new BadRequestException("No file has arrived yet for this upload");
    if (bytes.length > MAX_UPLOAD_BYTES) {
      await this.discard(p, row, "larger than the limit");
      throw new BadRequestException("That file is larger than the 10MB limit");
    }
    const actual = sniffUploadType(bytes);
    if (!actual) {
      await this.discard(p, row, "not a PDF, JPEG or PNG");
      throw new BadRequestException("That file is not a PDF, JPEG or PNG");
    }

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const updated = (await tx.documentSubmission.update({
        where: { id },
        data: {
          status: "UPLOADED",
          // The SNIFFED type, not the claimed one. What is stored is what the
          // bytes are.
          contentType: actual,
          sizeBytes: bytes.length,
          uploadedAt: new Date(),
        },
      })) as SubmissionRow;
      await this.audit.record(
        {
          actorId: p.userId,
          action: "document.submission.upload",
          entity: "document_submission",
          entityId: id,
          schoolId: p.schoolId,
          metadata: { subjectKind: row.subjectKind, contentType: actual, sizeBytes: bytes.length },
        },
        tx,
      );
      return this.toSubmissionDto(updated, new Map(), new Map());
    });
  }

  /** A rejected upload's bytes go; the row stays REJECTED with the reason. The
   *  app role cannot delete the row (rls/110) and should not — the trail of what
   *  was sent and why it was refused is the point. */
  private async discard(p: Principal, row: SubmissionRow, why: string): Promise<void> {
    if (row.storageKey) await this.storage.delete(row.storageKey).catch(() => undefined);
    await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await tx.documentSubmission.update({
        where: { id: row.id },
        data: { status: "REJECTED", rejectedReason: `Refused on upload: ${why}.`, storageKey: null },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "document.submission.refuse",
          entity: "document_submission",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { why },
        },
        tx,
      );
    });
  }

  async decide(
    p: Principal,
    id: string,
    decision: { status: Extract<SubmissionStatus, "VERIFIED" | "REJECTED">; reason?: string; expiresAt?: string },
  ): Promise<DocumentSubmissionDto> {
    if (decision.status === "REJECTED" && !decision.reason?.trim()) {
      // A refusal without a reason is one the family cannot act on, and they
      // will simply send the same file again.
      throw new BadRequestException("Say why it was rejected — the family sees this");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = (await tx.documentSubmission.findFirst({ where: { id } })) as SubmissionRow | null;
      if (!row) throw new NotFoundException("Submission not found");
      this.assertSubject(row.subjectKind);
      this.assertMayManage(p, SCOPE_OF_SUBJECT[row.subjectKind]);
      if (row.status === "PENDING") throw new BadRequestException("Nothing has arrived to judge yet");
      const updated = (await tx.documentSubmission.update({
        where: { id },
        data: {
          status: decision.status,
          verifiedById: p.userId,
          verifiedAt: new Date(),
          rejectedReason: decision.status === "REJECTED" ? decision.reason!.trim() : null,
          ...(decision.expiresAt ? { expiresAt: new Date(decision.expiresAt) } : {}),
        },
      })) as SubmissionRow;
      await this.audit.record(
        {
          actorId: p.userId,
          action: `document.submission.${decision.status.toLowerCase()}`,
          entity: "document_submission",
          entityId: id,
          schoolId: p.schoolId,
          metadata: { subjectKind: row.subjectKind, requirementId: row.requirementId },
        },
        tx,
      );
      return this.toSubmissionDto(updated, new Map(), new Map());
    });
  }

  /**
   * Close a requirement that will never be met.
   *
   * A waiver is a RECORDED DECISION, not a deletion and not a file: a birth
   * certificate lost in a flood, with a sworn declaration accepted instead. It
   * carries who decided and why, and it is the only reason a registrar's
   * outstanding list can ever reach zero — a list that never does stops being
   * read at all.
   */
  async waive(
    p: Principal,
    input: { subjectKind: string; subjectId: string; requirementId: string; reason: string },
  ): Promise<DocumentSubmissionDto> {
    this.assertSubject(input.subjectKind);
    this.assertMayManage(p, SCOPE_OF_SUBJECT[input.subjectKind]);
    if (!input.reason?.trim()) throw new BadRequestException("Say why this requirement is being waived");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireRequirement(tx, input.requirementId, input.subjectKind as SubmissionSubject);
      const row = (await tx.documentSubmission.create({
        data: {
          schoolId: p.schoolId,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          requirementId: input.requirementId,
          status: "WAIVED",
          // No storageKey, for ever: there is no file and there never will be.
          rejectedReason: input.reason.trim(),
          verifiedById: p.userId,
          verifiedAt: new Date(),
        },
      })) as SubmissionRow;
      await this.audit.record(
        {
          actorId: p.userId,
          action: "document.submission.waive",
          entity: "document_submission",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { subjectKind: input.subjectKind, requirementId: input.requirementId, reason: input.reason.trim() },
        },
        tx,
      );
      return this.toSubmissionDto(row, new Map(), new Map());
    });
  }

  /**
   * The bytes, for staff.
   *
   * Audited every time: this is a minor's identity document or a candidate's
   * personal papers (Golden Rule #5). The caller hands the result to the same
   * hardened response the Vault uses — octet-stream unless the type is inert,
   * always `attachment` — so a file cannot execute whatever it claims to be.
   */
  async file(p: Principal, id: string): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const row = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) =>
      (await tx.documentSubmission.findFirst({ where: { id } })) as SubmissionRow | null,
    );
    if (!row) throw new NotFoundException("Submission not found");
    this.assertSubject(row.subjectKind);
    this.assertMayManage(p, SCOPE_OF_SUBJECT[row.subjectKind]);
    if (!row.storageKey) throw new NotFoundException("This submission has no file");
    const buffer = await this.storage.download(row.storageKey);
    if (!buffer) throw new NotFoundException("File not found in storage");
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "document.submission.download",
          entity: "document_submission",
          entityId: id,
          schoolId: p.schoolId,
          metadata: { subjectKind: row.subjectKind },
        },
        tx,
      ),
    );
    return {
      buffer,
      filename: row.originalName ?? "document",
      contentType: row.contentType ?? "application/octet-stream",
    };
  }

  // --- helpers ---------------------------------------------------------------

  /** The requirement must exist, be this school's, and belong to the same side
   *  of the school as the subject — otherwise a pupil's file could be filed
   *  against "teaching licence". */
  private async requireRequirement(tx: TenantTx, id: string, subjectKind: SubmissionSubject): Promise<RequirementRow> {
    const req = (await tx.documentRequirement.findFirst({ where: { id } })) as RequirementRow | null;
    if (!req) throw new NotFoundException("Requirement not found");
    if (req.appliesTo !== SCOPE_OF_SUBJECT[subjectKind]) {
      throw new BadRequestException("That requirement belongs to a different kind of onboarding");
    }
    return req;
  }

  private async namesFor(tx: TenantTx, ids: Array<string | null>): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((i): i is string => !!i))];
    if (wanted.length === 0) return new Map();
    const users = (await tx.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, name: true },
    })) as Array<{ id: string; name: string }>;
    return new Map(users.map((u) => [u.id, u.name] as const));
  }

  private toRequirementDto(r: RequirementRow): DocumentRequirementDto {
    return {
      id: r.id,
      appliesTo: r.appliesTo,
      key: r.key,
      label: r.label,
      description: r.description,
      mandatory: r.mandatory,
      needsExpiry: r.needsExpiry,
      sequence: r.sequence,
      active: r.active,
    };
  }

  private toSubmissionDto(
    s: SubmissionRow,
    labels: Map<string, string>,
    names: Map<string, string>,
  ): DocumentSubmissionDto {
    return {
      id: s.id,
      requirementId: s.requirementId,
      requirementLabel: s.requirementId ? labels.get(s.requirementId) ?? null : null,
      originalName: s.originalName,
      contentType: s.contentType,
      sizeBytes: s.sizeBytes,
      status: s.status,
      uploadedByUserId: s.uploadedByUserId,
      uploadedAt: s.uploadedAt,
      verifiedById: s.verifiedById,
      verifiedByName: s.verifiedById ? names.get(s.verifiedById) ?? null : null,
      verifiedAt: s.verifiedAt,
      rejectedReason: s.rejectedReason,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
    };
  }
}
