import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { expandOccurrences, isStaffRoles } from "@sms/types";
import { MEETING_PROVIDERS, isMeetingJoinOpen, meetingJoinOpensAt, normalizeMeetingUrl } from "@sms/types";
import type { MeetingProvider } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { dateWindow } from "../common/status-filter";


/** Default calendar window when the caller doesn't name one. */
const DEFAULT_WINDOW_DAYS = 120;
/** How far before the window a one-off event may start and still overlap it. */
const MAX_EVENT_SPAN_MS = 30 * 86_400_000;
/** Hard cap on expanded occurrences so a wide window stays a bounded response. */
const MAX_EXPANDED = 1000;
// The candidate read's own bound, named so the truncation check cannot drift
// from the `take` it is checking against.
const CANDIDATE_CAP = 500;

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
  provider: string | null;
  joinUrl: string | null;
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
  /** Optional VIDEO meeting (staff meetings, parents evening). Server-validated. */
  provider?: string | null;
  joinUrl?: string | null;
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
    // STAFF IS DECIDED BY EXCLUSION, not by a list kept here.
    //
    // This was an allow-list of six role names, and nine staff roles had been
    // added to the platform since it was written. Measured live on a
    // STAFF-audience event: teacher and school_admin saw it; head_teacher,
    // hr_manager, librarian, warden, driver and junior_admin did not — a staff
    // meeting invisible to the head teacher, who is a stage-1 approver in the
    // staff-request chain.
    const staff = isStaffRoles(p.roles);
    // Shared with every other dated list. This one refused correctly and said
    // "Invalid window"; two siblings said "Invalid date range" and "from/to
    // must be YYYY-MM-DD"; six more did not refuse at all. Three hand-rolled
    // right answers is the shape that precedes a fourth being forgotten.
    const asked = dateWindow(opts.from, opts.to);
    const from = asked.from ?? new Date(Date.now() - 7 * 86_400_000);
    const to = asked.to ?? new Date(from.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // A row is a candidate when it starts before the window ends AND either
      // does not recur (its own end is in range) or its series may still reach
      // the window. Index-backed on (schoolId, startsAt).
      // A SERIES THAT HAS ENDED CANNOT REACH THIS WINDOW, and must not occupy a
      // candidate slot. The recurring branch had no lower bound at all — every
      // series ever created stayed a candidate for ever — and the page is
      // `startsAt ASC`, so the OLDEST dead series were fetched first and
      // `expandOccurrences` then returned nothing for each of them.
      //
      // Measured on a five-year secondary (600 weekly clubs, each run for one
      // academic year and ended, plus 10 real events inside the window):
      //
      //     600 dead series -> 0 occurrences   calendar BLANK
      //     495 dead series -> 5 occurrences   half the term missing, silently
      //     480 dead series -> 10 occurrences  correct
      //
      // The middle row is the dangerous one: a calendar that looks populated
      // and has quietly dropped half of what the school put in it.
      const candidateWhere = {
        startsAt: { lte: to },
        ...(staff ? {} : { audience: "ALL" as const }),
        OR: [
          { recurrence: "NONE", startsAt: { gte: new Date(from.getTime() - MAX_EVENT_SPAN_MS) } },
          {
            NOT: { recurrence: "NONE" },
            // Open-ended series always qualify; a bounded one only if it is
            // still running when the window opens.
            OR: [{ recurrenceUntil: null }, { recurrenceUntil: { gte: from } }],
          },
        ],
      };
      // One row past the cap, so truncation is DETECTED rather than assumed
      // absent — the defect above was invisible precisely because a full page
      // and a complete page looked identical.
      const fetched = (await tx.schoolEvent.findMany({
        where: candidateWhere,
        orderBy: { startsAt: "asc" },
        take: CANDIDATE_CAP + 1,
      })) as EventRow[];
      const truncated = fetched.length > CANDIDATE_CAP;
      const rows = truncated ? fetched.slice(0, CANDIDATE_CAP) : fetched;

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
      // Two places can drop something: the candidate read and the expansion.
      // Both are reported, because a calendar missing events must never look
      // like a calendar with none.
      return {
        items: out.slice(0, MAX_EXPANDED),
        truncated: truncated || out.length > MAX_EXPANDED,
      };
    });
  }

  /**
   * Validate an optional video link: a known provider AND a URL that survives the
   * shared validator (https + per-provider host allowlist), so a "Teams" event can
   * never be stored pointing at another domain. One without the other is a client
   * error, not a silently half-configured meeting.
   */
  private validateLink(provider?: string | null, joinUrl?: string | null): { provider: string | null; joinUrl: string | null } {
    const hasP = !!provider && provider.trim() !== "";
    const hasU = !!joinUrl && joinUrl.trim() !== "";
    if (!hasP && !hasU) return { provider: null, joinUrl: null };
    if (hasP !== hasU) throw new BadRequestException("A video meeting needs both a provider and a join link");
    if (!(MEETING_PROVIDERS as readonly string[]).includes(provider as string)) {
      throw new BadRequestException("Unknown meeting provider");
    }
    const url = normalizeMeetingUrl(provider as MeetingProvider, joinUrl as string);
    if (!url) throw new BadRequestException(`That is not a valid https ${provider} meeting link`);
    return { provider: provider as string, joinUrl: url };
  }

  async createEvent(p: Principal, input: EventInput) {
    const link = this.validateLink(input.provider, input.joinUrl);
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
