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
import type { FormDto, FormFieldDef, FormResponseDto } from "@sms/types";
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

  async listForms(p: Principal): Promise<FormDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where = this.canManage(p) ? {} : { status: "OPEN", audience: { in: this.audiences(p) } };
      const forms = await tx.form.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
      return Promise.all(forms.map((f: { id: string }) => this.formDto(tx, f.id, p)));
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
    return {
      id: form.id,
      title: form.title,
      description: form.description,
      fields: (form.fields as unknown as FormFieldDef[]) ?? [],
      audience: form.audience,
      anonymous: form.anonymous,
      status: form.status,
      createdByName: creator?.name ?? "",
      responseCount,
      hasResponded,
      createdAt: form.createdAt,
    };
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "form", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
