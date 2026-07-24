import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { expandOccurrences } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const STAFF = new Set(["school_admin", "principal", "accountant", "hr_clerk", "board", "teacher", "super_admin"]);
/** Default calendar window when the caller doesn't name one. */
const DEFAULT_WINDOW_DAYS = 120;
/** How far before the window a one-off event may start and still overlap it. */
const MAX_EVENT_SPAN_MS = 30 * 86_400_000;
/** Hard cap on expanded occurrences so a wide window stays a bounded response. */
const MAX_EXPANDED = 1000;

type EventRow = {
  id: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  audience: string;
  createdById: string;
  recurrence: string;
  recurrenceUntil: Date | null;
  recurrenceDays: unknown;
  createdAt: Date;
};

export interface EventInput {
  title: string;
  description?: string | null;
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  audience?: "ALL" | "STAFF";
  /** NONE | DAILY | WEEKLY | MONTHLY — one row describes the whole series. */
  recurrence?: string;
  recurrenceUntil?: string | null;
  /** WEEKLY only, e.g. ["MON","WED"]. Empty ⇒ the start date's own weekday. */
  recurrenceDays?: string[];
}

@Injectable()
export class EventsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /**
   * Events visible to the caller in a window (STAFF-audience events are hidden
   * from families). RECURRING events are stored as ONE row and expanded here for
   * the window, so a weekly assembly never becomes forty rows. Each occurrence
   * carries the series id plus its own start/end.
   */
  async listEvents(p: Principal, opts: { from?: string; to?: string } = {}) {
    const staff = p.roles.some((r) => STAFF.has(r));
    const from = opts.from ? new Date(opts.from) : new Date(Date.now() - 7 * 86_400_000);
    const to = opts.to ? new Date(opts.to) : new Date(from.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
      throw new BadRequestException("Invalid window");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // A row is a candidate when it starts before the window ends AND either
      // does not recur (its own end is in range) or its series may still reach
      // the window. Index-backed on (schoolId, startsAt).
      const rows = (await tx.schoolEvent.findMany({
        where: {
          startsAt: { lte: to },
          ...(staff ? {} : { audience: "ALL" }),
          OR: [
            { recurrence: "NONE", startsAt: { gte: new Date(from.getTime() - MAX_EVENT_SPAN_MS) } },
            { NOT: { recurrence: "NONE" } },
          ],
        },
        orderBy: { startsAt: "asc" },
        take: 500,
      })) as EventRow[];

      const out: Array<EventRow & { occurrenceStartsAt: Date; occurrenceEndsAt: Date | null }> = [];
      for (const e of rows) {
        const occurrences = expandOccurrences(
          {
            startsAt: e.startsAt,
            endsAt: e.endsAt,
            recurrence: e.recurrence,
            recurrenceUntil: e.recurrenceUntil,
            recurrenceDays: Array.isArray(e.recurrenceDays) ? (e.recurrenceDays as string[]) : [],
          },
          from,
          to,
        );
        for (const o of occurrences) out.push({ ...e, occurrenceStartsAt: o.startsAt, occurrenceEndsAt: o.endsAt });
        if (out.length >= MAX_EXPANDED) break; // bounded response
      }
      out.sort((x, y) => x.occurrenceStartsAt.getTime() - y.occurrenceStartsAt.getTime());
      return out.slice(0, MAX_EXPANDED);
    });
  }

  async createEvent(p: Principal, input: EventInput) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const e = await tx.schoolEvent.create({
        data: {
          schoolId: p.schoolId,
          title: input.title,
          description: input.description ?? null,
          startsAt: new Date(input.startsAt),
          endsAt: input.endsAt ? new Date(input.endsAt) : null,
          allDay: input.allDay ?? false,
          audience: input.audience ?? "ALL",
          createdById: p.userId,
          recurrence: input.recurrence ?? "NONE",
          recurrenceUntil: input.recurrenceUntil ? new Date(input.recurrenceUntil) : null,
          recurrenceDays: (input.recurrenceDays ?? []) as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "event.create", entity: "school_event", entityId: e.id, schoolId: p.schoolId },
        tx,
      );
      return e;
    });
  }

  async deleteEvent(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const e = await tx.schoolEvent.findFirst({ where: { id }, select: { id: true } });
      if (!e) throw new NotFoundException("Event not found");
      await tx.schoolEvent.delete({ where: { id } });
      await this.audit.record(
        { actorId: p.userId, action: "event.delete", entity: "school_event", entityId: id, schoolId: p.schoolId },
        tx,
      );
      return { id, deleted: true };
    });
  }
}
