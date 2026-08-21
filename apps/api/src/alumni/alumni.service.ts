// =============================================================================
// AlumniService — alumni records + broadcast
// =============================================================================
// Tenant-scoped (RLS). Staff (alumni.manage) record former students (contact +
// occupation), filter by graduation year, and broadcast a message to alumni who
// have a linked User account (via Notifications). Mutations audited.
// =============================================================================

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { ALUMNI_BROADCAST_QUEUE, ALUMNI_BROADCAST_JOB } from "./alumni.constants";
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

/** Recipients per transaction. Same constant as the meeting announcer: about
 *  four statements each, so a chunk is a short transaction rather than one that
 *  holds locks across the whole alumni body. */
const BROADCAST_CHUNK = 200;

@Injectable()
export class AlumniService {
  private readonly logger = new Logger("Alumni");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    @InjectQueue(ALUMNI_BROADCAST_QUEUE) private readonly queue: Queue,
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
  /**
   * Write to the alumni body.
   *
   * QUEUES the work and returns. The fan-out is unbounded — alumni only
   * accumulate, nobody stops being one — and doing it inside the request meant
   * the administrator waited while every inbox row, delivery row and audit row
   * was written: measured at 12.9 seconds for 2,000 even after chunking, and a
   * school with ten thousand would pass the gateway timeout and be told nothing
   * except that it failed, with no way to know how much had gone out.
   *
   * Returns the number of alumni it is going TO, which is the honest figure at
   * this point. `sent` was never "delivered" anyway — delivery is asynchronous
   * and always has been; it meant "inbox rows written", which is exactly what
   * the job now does.
   */
  /**
   * Message the alumni body — and say how much of it this actually reaches.
   *
   * A broadcast goes out as a NOTIFICATION, which is addressed to a user
   * account. An alumnus recorded after the fact has no account — `userId` is
   * nullable for exactly that reason — so those records are skipped. The count
   * returned was the reached ones alone, and the screen said "it goes out to
   * the alumni body", so a school with fifty alumni on file and three linked
   * accounts was told the broadcast was queued and never learnt that
   * forty-seven people were not written to.
   *
   * "Queued 3" and "queued 3, 47 have no account" are different facts, and the
   * second is the one that makes somebody go and collect email addresses. Same
   * reasoning as the fee run reporting what it skipped.
   */
  async broadcast(
    p: Principal,
    input: { title: string; body: string; year?: number },
  ): Promise<{ queued: number; unreachable: number }> {
    const { queued, unreachable } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const audience: Record<string, unknown> = {};
      if (input.year) audience.graduationYear = input.year;
      const [count, missing] = await Promise.all([
        tx.alumnus.count({ where: { ...audience, userId: { not: null } } }),
        tx.alumnus.count({ where: { ...audience, userId: null } }),
      ]);
      await this.log(tx, p, "alumni.broadcast", "broadcast", { year: input.year, count, unreachable: missing });
      return { queued: count, unreachable: missing };
    });
    if (queued > 0) {
      await this.queue.add(
        ALUMNI_BROADCAST_JOB,
        { schoolId: p.schoolId, actorId: p.userId, title: input.title, body: input.body, year: input.year },
        { removeOnComplete: true, removeOnFail: 50 },
      );
    }
    return { queued, unreachable };
  }

  /**
   * The fan-out itself, run by the processor.
   *
   * CHUNKED. `enqueueMany` writes a notification, its deliveries and an audit
   * row per recipient in ONE transaction; in chunks that is a series of short
   * transactions rather than one enormous one holding locks and flooding the
   * WAL, and a chunk that fails costs that chunk instead of the lot. The same
   * shape and the same constant the meeting announcer uses.
   */
  async fanOutBroadcast(
    ctx: { schoolId: string; actorId: string },
    input: { title: string; body: string; year?: number },
  ): Promise<number> {
    const actor = { schoolId: ctx.schoolId, userId: ctx.actorId };
    const recipients = await this.db.runAsTenant(actor, async (tx) => {
      const where: Record<string, unknown> = { userId: { not: null } };
      if (input.year) where.graduationYear = input.year;
      const rows = await tx.alumnus.findMany({ where, select: { userId: true } });
      return rows.map((r: { userId: string | null }) => r.userId).filter((u): u is string => Boolean(u));
    });
    let sent = 0;
    for (let i = 0; i < recipients.length; i += BROADCAST_CHUNK) {
      const chunk = recipients.slice(i, i + BROADCAST_CHUNK);
      try {
        await this.notifications.enqueueMany(actor, chunk, {
          type: "ALUMNI_BROADCAST",
          title: input.title,
          body: input.body,
          data: {},
          channels: ["EMAIL"],
        });
        sent += chunk.length;
      } catch (err) {
        // Reported, never silently dropped: a half-landed broadcast that claims
        // success is how alumni get written to twice.
        this.logger.error(`Alumni broadcast chunk ${i}-${i + chunk.length} failed: ${String(err)}`);
      }
    }
    return sent;
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
