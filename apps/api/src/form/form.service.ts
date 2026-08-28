// =============================================================================
// FormService — form builder (surveys / feedback / performance reviews)
// =============================================================================
// Tenant-scoped (RLS). Staff (form.manage) build a form with a JSON field schema
// for an audience, and read responses. Members (form.respond) see open forms in
// their audience and submit ONE response. ANONYMITY: when a form is anonymous, no
// read returns respondentId/name — only the answers (identity recorded solely to
// enforce one-per-member, mirroring the polling model). Audited — but a response
// to an ANONYMOUS form is audited under the SYSTEM actor, because an audit row
// naming the respondent, timestamped alongside a timestamped answer, attributed
// every answer to a pupil on the screen next door.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { isStaffRoles } from "@sms/types";
import type { PageDto, FormDto, FormFieldDef, FormResponseDto } from "@sms/types";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";
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


/**
 * Midnight UTC of a timestamp's own day.
 *
 * Deliberately UTC rather than the school's timezone: this exists to REMOVE
 * precision, a day either side is no loss, and reaching for the region service
 * here would add a dependency to buy nothing. It also lands on the exact-UTC-
 * midnight shape the web already renders as a calendar date rather than
 * converting.
 */
function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

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
    const studentSideOnly = !isStaffRoles(p.roles);
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
      // ANONYMITY BEATS ATTRIBUTION HERE.
      //
      // Auditing this with the real actor undid the whole feature. The form
      // screen showed `respondentName: null` while the audit viewer — one click
      // away, open to the same principal — showed "Demo Student" against the
      // same form four milliseconds later. Both screens carry timestamps and the
      // answers list is timestamped too, so the pair did not merely reveal WHO
      // took part: it attributed each answer to a named pupil. On the survey a
      // school runs about bullying, or about its own leadership, read by exactly
      // the people the anonymity is meant to hold at arm's length.
      //
      // The event is still recorded — a response arrived, on this form, at this
      // time — under the SYSTEM actor, so the operational trail survives and the
      // link does not exist to be read. Not merely hidden from the viewer:
      // absent from the row, so a backup, a restore drill or a support query
      // cannot reconstruct it either.
      await this.logAs(tx, form.anonymous ? SYSTEM_ACTOR_ID : p.userId, p.schoolId, "form.respond", formId, {
        anonymous: form.anonymous,
      });
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
      /**
       * ORDERED NON-TEMPORALLY FOR AN ANONYMOUS FORM.
       *
       * `createdAt: "desc"` reconstructs the ARRIVAL SEQUENCE, which is a second
       * correlation handle beside the timestamp itself: the third row is the
       * third person to answer. Ordering by id gives staff a stable list and
       * says nothing about when anyone submitted.
       */
      const rows = await tx.formResponse.findMany({
        where: { formId },
        orderBy: form.anonymous ? { id: "asc" } : { createdAt: "desc" },
        take: 1000,
      });
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
        // ANONYMITY, SECOND HALF. Hiding the NAME is not enough while the row
        // carries the instant it arrived.
        //
        // This repo already measured the same channel on the poll: a vote row
        // and a request-log line "thirteen milliseconds apart, so log + database
        // recovers not just WHO voted but WHAT THEY CHOSE". That was closed by
        // withholding `user_id` from the log ON THE VOTE ROUTE — and every OTHER
        // request the same pupil makes still carries their id, so a response
        // stamped to the millisecond is the same join from the other end.
        //
        // Polls are safe from it because their read returns per-option TALLIES.
        // A form cannot: the answers are free text and staff genuinely need each
        // one. So the precision goes instead — truncated to the DAY, which is
        // what "when was this survey answered" actually needs. Measured live
        // before this: a child's report of being bullied, returned with
        // `createdAt: 2026-08-27T10:18:12.351Z`.
        createdAt: form.anonymous ? startOfUtcDay(r.createdAt) : r.createdAt,
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
    return this.logAs(tx, p.userId, p.schoolId, action, entityId, metadata);
  }

  /**
   * Audit under an explicit actor — the SYSTEM actor when the event must not be
   * attributable. See `respond`: naming the actor on an anonymous form is what
   * deanonymised it.
   */
  private logAs(
    tx: TenantTx,
    actorId: string,
    schoolId: string,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.record({ actorId, action, entity: "form", entityId, schoolId, metadata }, tx);
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
