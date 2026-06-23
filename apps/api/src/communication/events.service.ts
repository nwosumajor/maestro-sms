import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const STAFF = new Set(["school_admin", "principal", "accountant", "hr_clerk", "board", "teacher", "super_admin"]);

export interface EventInput {
  title: string;
  description?: string | null;
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  audience?: "ALL" | "STAFF";
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

  /** Upcoming events visible to the caller (STAFF-audience events hidden from families). */
  async listEvents(p: Principal) {
    const staff = p.roles.some((r) => STAFF.has(r));
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.schoolEvent.findMany({
        where: {
          startsAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
          ...(staff ? {} : { audience: "ALL" }),
        },
        orderBy: { startsAt: "asc" },
        take: 200,
      }),
    );
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
