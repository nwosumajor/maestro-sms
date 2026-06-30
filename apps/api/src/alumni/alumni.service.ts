// =============================================================================
// AlumniService — alumni records + broadcast
// =============================================================================
// Tenant-scoped (RLS). Staff (alumni.manage) record former students (contact +
// occupation), filter by graduation year, and broadcast a message to alumni who
// have a linked User account (via Notifications). Mutations audited.
// =============================================================================

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { AlumnusDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";

interface AlumnusInput {
  userId?: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  graduationYear?: number | null;
  lastClass?: string | null;
  occupation?: string | null;
  notes?: string | null;
}

@Injectable()
export class AlumniService {
  private readonly logger = new Logger("Alumni");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async create(p: Principal, input: AlumnusInput): Promise<AlumnusDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.alumnus.create({
        data: {
          schoolId: p.schoolId,
          userId: input.userId ?? null,
          name: input.name,
          email: input.email ?? null,
          phone: input.phone ?? null,
          graduationYear: input.graduationYear ?? null,
          lastClass: input.lastClass ?? null,
          occupation: input.occupation ?? null,
          notes: input.notes ?? null,
          createdById: p.userId,
        },
      });
      await this.log(tx, p, "alumni.create", a.id, { graduationYear: input.graduationYear });
      return this.dto(a);
    });
  }

  async update(p: Principal, id: string, input: Partial<AlumnusInput>): Promise<AlumnusDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.alumnus.findFirst({ where: { id } });
      if (!existing) throw new NotFoundException("Alumnus not found");
      const a = await tx.alumnus.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.graduationYear !== undefined ? { graduationYear: input.graduationYear } : {}),
          ...(input.lastClass !== undefined ? { lastClass: input.lastClass } : {}),
          ...(input.occupation !== undefined ? { occupation: input.occupation } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
      await this.log(tx, p, "alumni.update", id, { fields: Object.keys(input) });
      return this.dto(a);
    });
  }

  async list(p: Principal, opts: { year?: number; q?: string } = {}): Promise<AlumnusDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = {};
      if (opts.year) where.graduationYear = opts.year;
      if (opts.q?.trim()) where.name = { contains: opts.q.trim(), mode: "insensitive" };
      const rows = await tx.alumnus.findMany({ where, orderBy: [{ graduationYear: "desc" }, { name: "asc" }], take: 500 });
      return rows.map((a) => this.dto(a));
    });
  }

  /** Broadcast a message to alumni who have a linked User account (in-app + email). */
  async broadcast(p: Principal, input: { title: string; body: string; year?: number }): Promise<{ sent: number }> {
    const recipients = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = { userId: { not: null } };
      if (input.year) where.graduationYear = input.year;
      const rows = await tx.alumnus.findMany({ where, select: { userId: true } });
      await this.log(tx, p, "alumni.broadcast", "broadcast", { year: input.year, count: rows.length });
      return rows.map((r: { userId: string | null }) => r.userId).filter((u): u is string => Boolean(u));
    });
    let sent = 0;
    for (const userId of recipients) {
      try {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: userId,
          type: "ALUMNI_BROADCAST",
          title: input.title,
          body: input.body,
          data: {},
          channels: ["EMAIL"],
        });
        sent++;
      } catch (err) {
        this.logger.error(`Alumni broadcast to ${userId} failed: ${String(err)}`);
      }
    }
    return { sent };
  }

  private dto(a: {
    id: string; userId: string | null; name: string; email: string | null; phone: string | null;
    graduationYear: number | null; lastClass: string | null; occupation: string | null; notes: string | null; createdAt: Date;
  }): AlumnusDto {
    return {
      id: a.id, userId: a.userId, name: a.name, email: a.email, phone: a.phone,
      graduationYear: a.graduationYear, lastClass: a.lastClass, occupation: a.occupation, notes: a.notes, createdAt: a.createdAt,
    };
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "alumnus", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
