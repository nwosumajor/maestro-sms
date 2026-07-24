// =============================================================================
// FormService — form builder (surveys / feedback / performance reviews)
// =============================================================================
// Tenant-scoped (RLS). Staff (form.manage) build a form with a JSON field schema
// for an audience, and read responses. Members (form.respond) see open forms in
// their audience and submit ONE response. ANONYMITY: when a form is anonymous, no
// read returns respondentId/name — only the answers (identity recorded solely to
// enforce one-per-member, mirroring the polling model). Audited.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import type { PageDto, FormDto, FormFieldDef, FormResponseDto } from "@sms/types";
import { decodeCursor, pageLimit, seekWhere, toPage } from "../common/keyset-cursor";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const STUDENT_SIDE_ROLES = new Set(["student", "parent"]);

@Injectable()
export class FormService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private canManage(p: Principal): boolean {
    return p.permissions.includes("form.manage");
  }
  private audiences(p: Principal): string[] {
    const studentSideOnly = p.roles.every((r) => STUDENT_SIDE_ROLES.has(r));
    return studentSideOnly ? ["ALL", "STUDENTS"] : ["ALL", "STUDENTS", "STAFF"];
  }

  async createForm(
    p: Principal,
    input: { title: string; description?: string; fields: FormFieldDef[]; audience: "ALL" | "STUDENTS" | "STAFF"; anonymous?: boolean },
  ): Promise<FormDto> {
    if (input.fields.length === 0) throw new BadRequestException("a form needs at least one field");
    const keys = new Set<string>();
    for (const f of input.fields) {
      if (!f.key || !f.label || !f.type) throw new BadRequestException("each field needs key, label, and type");
      if (keys.has(f.key)) throw new BadRequestException("duplicate field key");
      keys.add(f.key);
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const form = await tx.form.create({
        data: {
          schoolId: p.schoolId,
          title: input.title,
          description: input.description ?? null,
          fields: input.fields as unknown as Prisma.InputJsonValue,
          audience: input.audience,
          anonymous: input.anonymous ?? false,
          status: "OPEN",
          createdById: p.userId,
        },
      });
      await this.log(tx, p, "form.create", form.id, { audience: input.audience, fields: input.fields.length, anonymous: form.anonymous });
      return this.formDto(tx, form.id, p);
    });
  }

  async closeForm(p: Principal, id: string): Promise<FormDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const form = await tx.form.findFirst({ where: { id } });
      if (!form) throw new NotFoundException("Form not found");
      if (form.createdById !== p.userId && !this.canManage(p)) throw new ForbiddenException("Not allowed");
      await tx.form.update({ where: { id }, data: { status: "CLOSED" } });
      await this.log(tx, p, "form.close", id, {});
      return this.formDto(tx, id, p);
    });
  }

  async respond(p: Principal, formId: string, answers: Record<string, string | number>): Promise<FormDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const form = await tx.form.findFirst({ where: { id: formId } });
      if (!form) throw new NotFoundException("Form not found");
      if (form.status !== "OPEN") throw new BadRequestException("Form is closed");
      if (!this.canManage(p) && !this.audiences(p).includes(form.audience)) throw new ForbiddenException("Not in this form's audience");
      const fields = (form.fields as unknown as FormFieldDef[]) ?? [];
      for (const f of fields) {
        if (f.required && (answers[f.key] === undefined || answers[f.key] === "")) {
          throw new BadRequestException(`"${f.label}" is required`);
        }
      }
      const already = await tx.formResponse.findFirst({ where: { formId, respondentId: p.userId }, select: { id: true } });
      if (already) throw new BadRequestException("You have already responded to this form");
      await tx.formResponse.create({ data: { schoolId: p.schoolId, formId, respondentId: p.userId, answers: answers as unknown as Prisma.InputJsonValue } });
      await this.log(tx, p, "form.respond", formId, {});
      return this.formDto(tx, formId, p);
    });
  }

  async listForms(p: Principal, opts: { cursor?: string; limit?: number } = {}): Promise<PageDto<FormDto>> {
    const limit = pageLimit(opts.limit);
    const cursor = decodeCursor(opts.cursor);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where = this.canManage(p) ? {} : { status: "OPEN", audience: { in: this.audiences(p) } };
      const rows = (await tx.form.findMany({
        where: { ...where, ...seekWhere(cursor) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      })) as FormRow[];
      const page = toPage(rows, limit);
      const forms = page.items;
      if (forms.length === 0) return { items: [], nextCursor: null };
      // Batch counts / own-response / creator names (was 4 queries per form via
      // formDto — ~800 for a full page).
      const formIds = forms.map((f) => f.id);
      const counts = (await tx.formResponse.groupBy({
        by: ["formId"],
        where: { formId: { in: formIds } },
        _count: { _all: true },
      } as never)) as unknown as Array<{ formId: string; _count: { _all: number } }>;
      const countOf = new Map(counts.map((c) => [c.formId, c._count._all]));
      // The caller's OWN responses only — never anyone else's identity.
      const mine = await tx.formResponse.findMany({
        where: { formId: { in: formIds }, respondentId: p.userId },
        select: { formId: true },
      });
      const responded = new Set(mine.map((r: { formId: string }) => r.formId));
      const creators = await tx.user.findMany({
        where: { id: { in: [...new Set(forms.map((f) => f.createdById))] } },
        select: { id: true, name: true },
      });
      const nameOf = new Map(creators.map((u: { id: string; name: string }) => [u.id, u.name]));
      return {
        items: forms.map((f) => mapFormDto(f, countOf.get(f.id) ?? 0, responded.has(f.id), nameOf.get(f.createdById) ?? "")),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** Responses for a form (staff). Respondent identity is hidden for anonymous forms. */
  async responses(p: Principal, formId: string): Promise<FormResponseDto[]> {
    if (!this.canManage(p)) throw new ForbiddenException("Staff only");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const form = await tx.form.findFirst({ where: { id: formId } });
      if (!form) throw new NotFoundException("Form not found");
      const rows = await tx.formResponse.findMany({ where: { formId }, orderBy: { createdAt: "desc" }, take: 1000 });
      await this.log(tx, p, "form.responses.read", formId, { count: rows.length });
      let nameOf = new Map<string, string>();
      if (!form.anonymous) {
        const ids = [...new Set<string>(rows.map((r: { respondentId: string }) => r.respondentId))];
        const users = ids.length ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
        nameOf = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
      }
      return rows.map((r: { id: string; respondentId: string; answers: unknown; createdAt: Date }) => ({
        id: r.id,
        // ANONYMITY: never expose the respondent for an anonymous form.
        respondentName: form.anonymous ? null : (nameOf.get(r.respondentId) ?? ""),
        answers: (r.answers ?? {}) as Record<string, string | number>,
        createdAt: r.createdAt,
      }));
    });
  }

  private async formDto(tx: TenantTx, formId: string, p: Principal): Promise<FormDto> {
    const form = await tx.form.findFirstOrThrow({ where: { id: formId } });
    const responseCount = await tx.formResponse.count({ where: { formId } });
    const hasResponded = Boolean(await tx.formResponse.findFirst({ where: { formId, respondentId: p.userId }, select: { id: true } }));
    const creator = await tx.user.findFirst({ where: { id: form.createdById }, select: { name: true } });
    return mapFormDto(form as FormRow, responseCount, hasResponded, creator?.name ?? "");
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "form", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}

type FormRow = {
  id: string;
  title: string;
  description: string | null;
  fields: unknown;
  audience: string;
  anonymous: boolean;
  status: string;
  createdById: string;
  createdAt: Date;
};

/**
 * Pure form-row → DTO. The response count, the caller's own has-responded flag
 * and the creator's name are supplied by the caller — fetched once for a single
 * form or batched across the page — so listing never fans out. `hasResponded`
 * only ever reflects the CALLER's own response, never another respondent's
 * identity (which anonymous forms must not leak).
 */
function mapFormDto(form: FormRow, responseCount: number, hasResponded: boolean, createdByName: string): FormDto {
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    fields: (form.fields as unknown as FormFieldDef[]) ?? [],
    audience: form.audience,
    anonymous: form.anonymous,
    status: form.status,
    createdByName,
    responseCount,
    hasResponded,
    createdAt: form.createdAt,
  };
}
