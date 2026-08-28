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
  ): Promise<{ queued: number; unreachable: number; closedAccounts: number }> {
    const { queued, unreachable, closedAccounts } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const audience: Record<string, unknown> = {};
      if (input.year) audience.graduationYear = input.year;
      // HAVING AN ACCOUNT IS NOT THE SAME AS BEING REACHABLE.
      //
      // `queued` counted alumni with a linked account, and `unreachable` counted
      // those without one. But `NotificationService.persist` drops every
      // EXTERNAL channel for a recipient whose status is not ACTIVE — and an
      // alumnus has LEFT by definition, so their account is exactly that.
      //
      // Measured live: broadcast to one alumna linked to a departed pupil ->
      // `{"queued":1,"unreachable":0}`, ONE in-app row, and ZERO email
      // deliveries. She cannot open the inbox either, because a non-ACTIVE user
      // cannot sign in. The field that exists to report who was not reached
      // counted the wrong population, and the larger one.
      //
      // The UI already went through the first layer of this — "a school with
      // fifty on file and three linked accounts was told it had gone out" — and
      // the second layer is the majority case.
      // COUNTED IN THE DATABASE, never by loading the register.
      //
      // An alumni roll only ever grows — nobody stops being an alumnus — so
      // hydrating every row to answer a question about three numbers is exactly
      // the "count in the database, never findMany().length" rule this codebase
      // already states for the dashboard headcount. An existing test guards it,
      // and it caught a first version of this fix that loaded every row.
      //
      // The raw count carries the join the schema has no Prisma relation for:
      // `alumnus.userId` is a scalar with a DB FK, the documented pattern that
      // keeps the User model lean.
      const year = input.year ?? null;
      const [linkedTotal, missing] = await Promise.all([
        tx.alumnus.count({ where: { ...audience, userId: { not: null } } }),
        tx.alumnus.count({ where: { ...audience, userId: null } }),
      ]);
      const reachable = (await tx.$queryRaw`
        SELECT count(*) AS n
        FROM "alumnus" a
        JOIN "user" u ON u.id = a."userId"
        WHERE u.status = 'ACTIVE'
          AND (${year}::int IS NULL OR a."graduationYear" = ${year}::int)
      `) as Array<{ n: bigint }>;
      const active = Number(reachable[0]?.n ?? 0);
      const closed = Math.max(0, linkedTotal - active);
      // The screen is read once; the audit row is what answers "why did the
      // class of 2015 never hear from us" a year later — and it now records the
      // reason, not just the shortfall.
      await this.log(tx, p, "alumni.broadcast", "broadcast", {
        year: input.year,
        count: active,
        unreachable: missing + closed,
        closedAccounts: closed,
      });
      return { queued: active, unreachable: missing + closed, closedAccounts: closed };
    });
    if (queued > 0) {
      await this.queue.add(
        ALUMNI_BROADCAST_JOB,
        { schoolId: p.schoolId, actorId: p.userId, title: input.title, body: input.body, year: input.year },
        { removeOnComplete: true, removeOnFail: 50 },
      );
    }
    return { queued, unreachable, closedAccounts };
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
      const linked = rows.map((r: { userId: string | null }) => r.userId).filter((u): u is string => Boolean(u));
      if (linked.length === 0) return [];
      // ONLY THOSE THE FUNNEL WILL ACTUALLY DELIVER TO, so `sent` is a true
      // number and no message is written into an inbox its owner cannot open.
      const active = (await tx.user.findMany({
        where: { id: { in: linked }, status: "ACTIVE" },
        select: { id: true },
      })) as Array<{ id: string }>;
      return active.map((u) => u.id);
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
