// =============================================================================
// PollService — anonymous opinion polls
// =============================================================================
// Tenant-scoped (RLS). Staff (poll.manage) create a poll with options for an
// audience; members (poll.vote) cast ONE anonymous vote. ANONYMITY is structural:
//   - the vote write stores voterId ONLY to enforce one-vote-per-member (unique
//     [pollId, voterId]) and to audit participation;
//   - NO read ever returns voterId↔optionId together — results are per-option
//     TALLIES via groupBy(optionId), and hasVoted is a boolean existence check.
//   - voters see tallies only AFTER the poll closes (live votes stay blind); the
//     creator/staff can see them anytime.
// Audited (create/close/vote — the vote audit records THAT a member voted, never
// the chosen option).
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PollDto } from "@sms/types";
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
export class PollService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private canManage(p: Principal): boolean {
    return p.permissions.includes("poll.manage");
  }
  /** Audiences the caller belongs to (mirrors announcements). */
  private callerAudiences(p: Principal): Set<string> {
    const studentSideOnly = p.roles.every((r) => STUDENT_SIDE_ROLES.has(r));
    return new Set(studentSideOnly ? ["ALL", "STUDENTS"] : ["ALL", "STUDENTS", "STAFF"]);
  }

  // --- manage ---------------------------------------------------------------

  async createPoll(
    p: Principal,
    input: { question: string; audience: "ALL" | "STUDENTS" | "STAFF"; options: string[]; closesAt?: string | null },
  ): Promise<PollDto> {
    const opts = input.options.map((o) => o.trim()).filter(Boolean);
    if (opts.length < 2) throw new BadRequestException("a poll needs at least two options");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const poll = await tx.poll.create({
        data: {
          schoolId: p.schoolId,
          question: input.question,
          audience: input.audience,
          createdById: p.userId,
          status: "OPEN",
          closesAt: input.closesAt ? new Date(input.closesAt) : null,
        },
      });
      let seq = 0;
      for (const label of opts) {
        await tx.pollOption.create({ data: { schoolId: p.schoolId, pollId: poll.id, label, sequence: seq++ } });
      }
      await this.log(tx, p, "poll.create", poll.id, { audience: input.audience, options: opts.length });
      return this.pollDto(tx, poll.id, p);
    });
  }

  async closePoll(p: Principal, id: string): Promise<PollDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const poll = await tx.poll.findFirst({ where: { id } });
      if (!poll) throw new NotFoundException("Poll not found");
      if (poll.createdById !== p.userId && !this.canManage(p)) throw new ForbiddenException("Not allowed");
      await tx.poll.update({ where: { id }, data: { status: "CLOSED" } });
      await this.log(tx, p, "poll.close", id, {});
      return this.pollDto(tx, id, p);
    });
  }

  // --- vote -----------------------------------------------------------------

  async vote(p: Principal, pollId: string, optionId: string): Promise<PollDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const poll = await tx.poll.findFirst({ where: { id: pollId } });
      if (!poll) throw new NotFoundException("Poll not found");
      if (poll.status !== "OPEN") throw new BadRequestException("Poll is closed");
      if (poll.closesAt && poll.closesAt.getTime() < Date.now()) throw new BadRequestException("Poll has expired");
      // Audience gate: the caller must belong to the poll's audience.
      if (!this.callerAudiences(p).has(poll.audience)) throw new ForbiddenException("You are not in this poll's audience");
      const option = await tx.pollOption.findFirst({ where: { id: optionId, pollId }, select: { id: true } });
      if (!option) throw new BadRequestException("Invalid option for this poll");
      const already = await tx.pollVote.findFirst({ where: { pollId, voterId: p.userId }, select: { id: true } });
      if (already) throw new BadRequestException("You have already voted in this poll");
      await tx.pollVote.create({ data: { schoolId: p.schoolId, pollId, optionId, voterId: p.userId } });
      // Audit records ONLY that this member voted — never which option.
      await this.log(tx, p, "poll.vote", pollId, {});
      return this.pollDto(tx, pollId, p);
    });
  }

  // --- reads ----------------------------------------------------------------

  /** Polls visible to the caller (their audience), newest first. */
  async listPolls(p: Principal): Promise<PollDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const audiences = [...this.callerAudiences(p)];
      // Staff/creator see all polls; others see only polls for their audience.
      const where = this.canManage(p) ? {} : { audience: { in: audiences } };
      const polls = await tx.poll.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
      return Promise.all(polls.map((poll: { id: string }) => this.pollDto(tx, poll.id, p)));
    });
  }

  // --- helpers --------------------------------------------------------------

  private async pollDto(tx: TenantTx, pollId: string, p: Principal): Promise<PollDto> {
    const poll = await tx.poll.findFirstOrThrow({ where: { id: pollId } });
    const options = await tx.pollOption.findMany({ where: { pollId }, orderBy: { sequence: "asc" } });
    const creator = await tx.user.findFirst({ where: { id: poll.createdById }, select: { name: true } });

    const hasVoted = Boolean(await tx.pollVote.findFirst({ where: { pollId, voterId: p.userId }, select: { id: true } }));
    const isClosed = poll.status === "CLOSED" || (poll.closesAt ? poll.closesAt.getTime() < Date.now() : false);
    // Results are visible to staff/creator anytime, or to anyone once the poll is
    // closed. Live voters never see tallies (keeps in-progress votes blind).
    const resultsVisible = this.canManage(p) || poll.createdById === p.userId || isClosed;

    // ANONYMITY: tallies via groupBy(optionId) — voterId is never read here.
    let tallyByOption = new Map<string, number>();
    let totalVotes = 0;
    if (resultsVisible) {
      const grouped = (await tx.pollVote.groupBy({
        by: ["optionId"],
        where: { pollId },
        _count: { _all: true },
      } as never)) as unknown as Array<{ optionId: string; _count: { _all: number } }>;
      tallyByOption = new Map(grouped.map((g) => [g.optionId, g._count._all]));
      totalVotes = grouped.reduce((s, g) => s + g._count._all, 0);
    } else {
      totalVotes = await tx.pollVote.count({ where: { pollId } });
    }

    return {
      id: poll.id,
      question: poll.question,
      audience: poll.audience,
      status: isClosed ? "CLOSED" : poll.status,
      createdById: poll.createdById,
      createdByName: creator?.name ?? "",
      closesAt: poll.closesAt,
      options: options.map((o: { id: string; label: string }) => ({
        id: o.id,
        label: o.label,
        votes: resultsVisible ? (tallyByOption.get(o.id) ?? 0) : 0,
      })),
      totalVotes,
      hasVoted,
      resultsVisible,
      createdAt: poll.createdAt,
    };
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "poll", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
