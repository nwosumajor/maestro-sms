// =============================================================================
// PollService — anonymous opinion polls
// =============================================================================
// Tenant-scoped (RLS). Staff (poll.manage) create a poll with options for an
// audience; members (poll.vote) cast ONE anonymous vote. ANONYMITY is structural:
//   - the vote write stores voterId ONLY to enforce one-vote-per-member (unique
//     [pollId, voterId]) — NOT to audit participation: the audit row is written
//     under the SYSTEM actor, because naming the voter there handed leadership
//     the roll of who answered a poll about leadership;
//   - NO read ever returns voterId↔optionId together — results are per-option
//     TALLIES via groupBy(optionId), and hasVoted is a boolean existence check.
//   - voters see tallies only AFTER the poll closes (live votes stay blind); the
//     creator/staff can see them anytime.
// Audited (create/close/vote — the vote audit records THAT a member voted, never
// the chosen option).
// =============================================================================

import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { isStaffRoles } from "@sms/types";
import type { PageDto, PollDto } from "@sms/types";
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
    const studentSideOnly = !isStaffRoles(p.roles);
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
      // One bulk insert for the options (not one INSERT per option).
      await tx.pollOption.createMany({
        data: opts.map((label, i) => ({ schoolId: p.schoolId, pollId: poll.id, label, sequence: i })),
      });
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

  // ---------------------------------------------------------------------------
  // Editing and removing a poll
  // ---------------------------------------------------------------------------
  // A poll could be created and closed and nothing else. A typo in the question,
  // a missing option, a poll posted to the wrong audience — all permanent, so
  // the only remedy was to post a second poll and leave the wrong one up.
  //
  // THE RULE, the same one the exam bank uses: while nobody has answered, it is
  // a draft and everything is editable. Once somebody has voted, the thing they
  // answered is fixed — changing the question under a tally makes the result a
  // statement about a question nobody was asked, and renaming an option changes
  // what a vote meant after the fact.
  //
  // `closesAt` is the exception and stays editable: extending or shortening a
  // deadline does not change what was asked or what anyone answered.
  //
  // Deleting follows the SAME rule, and the database is what settles it: the app
  // role holds SELECT and INSERT on poll_vote and nothing else (rls/40), so a
  // cast vote cannot be removed by this application at all. A poll that people
  // answered is closed, never deleted; an empty one can go.
  //
  // That was not the design I started with — I had deletion cascading through
  // the votes, and it failed live with 42501 permission denied. The grant is the
  // real policy and it is the stricter one, so the service now matches it rather
  // than the privilege being widened to suit the feature.

  /** Correct a poll. Refused once anyone has voted, except the deadline. */
  async updatePoll(
    p: Principal,
    id: string,
    input: { question?: string; audience?: "ALL" | "STUDENTS" | "STAFF"; closesAt?: string | null },
  ): Promise<PollDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const poll = await tx.poll.findFirst({ where: { id } });
      if (!poll) throw new NotFoundException("Poll not found");
      if (poll.createdById !== p.userId && !this.canManage(p)) throw new ForbiddenException("Not allowed");

      const changesTheQuestion = input.question !== undefined || input.audience !== undefined;
      if (changesTheQuestion) {
        const votes = await tx.pollVote.count({ where: { pollId: id } });
        if (votes > 0) {
          throw new ConflictException(
            `${votes} ${votes === 1 ? "person has" : "people have"} already voted, so the question and audience are fixed — a tally has to stay attached to the question that was actually asked. You can still change the closing time, or close this poll and post a corrected one.`,
          );
        }
      }
      if (input.question !== undefined && !input.question.trim()) {
        throw new BadRequestException("A poll needs a question");
      }
      const data: Record<string, unknown> = {};
      if (input.question !== undefined) data.question = input.question.trim();
      if (input.audience !== undefined) data.audience = input.audience;
      if (input.closesAt !== undefined) data.closesAt = input.closesAt ? new Date(input.closesAt) : null;
      if (Object.keys(data).length > 0) {
        await tx.poll.update({ where: { id }, data });
        await this.log(tx, p, "poll.update", id, { fields: Object.keys(data).sort() });
      }
      return this.pollDto(tx, id, p);
    });
  }

  /** Replace the option list. Refused once anyone has voted.
   *
   *  A REPLACE rather than add/rename/remove endpoints: the options are one
   *  thing a reader sees as a list, the screen edits them as a list, and three
   *  separate endpoints would each need the same "has anyone voted" guard with
   *  three chances to forget it. */
  async setPollOptions(p: Principal, id: string, labels: string[]): Promise<PollDto> {
    const opts = labels.map((o) => o.trim()).filter(Boolean);
    if (opts.length < 2) throw new BadRequestException("a poll needs at least two options");
    if (opts.length > 10) throw new BadRequestException("a poll takes at most 10 options");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const poll = await tx.poll.findFirst({ where: { id } });
      if (!poll) throw new NotFoundException("Poll not found");
      if (poll.createdById !== p.userId && !this.canManage(p)) throw new ForbiddenException("Not allowed");
      const votes = await tx.pollVote.count({ where: { pollId: id } });
      if (votes > 0) {
        throw new ConflictException(
          `${votes} ${votes === 1 ? "person has" : "people have"} already voted, so the options are fixed — removing one would discard their answer and renaming one would change what they chose.`,
        );
      }
      // No votes exist, so nothing references these rows.
      await tx.pollOption.deleteMany({ where: { pollId: id } });
      await tx.pollOption.createMany({
        data: opts.map((label, i) => ({ schoolId: p.schoolId, pollId: id, label, sequence: i })),
      });
      await this.log(tx, p, "poll.options.set", id, { options: opts.length });
      return this.pollDto(tx, id, p);
    });
  }

  /** Remove a poll nobody has answered. */
  async deletePoll(p: Principal, id: string): Promise<{ id: string; deleted: true }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const poll = await tx.poll.findFirst({ where: { id } });
      if (!poll) throw new NotFoundException("Poll not found");
      if (poll.createdById !== p.userId && !this.canManage(p)) throw new ForbiddenException("Not allowed");
      const votes = await tx.pollVote.count({ where: { pollId: id } });
      if (votes > 0) {
        throw new ConflictException(
          `${votes} ${votes === 1 ? "person has" : "people have"} already voted, so this poll cannot be deleted — their answers are a record the school keeps. Close it instead; a closed poll stops taking votes and shows its result.`,
        );
      }
      // No votes, so nothing references the options.
      await tx.pollOption.deleteMany({ where: { pollId: id } });
      await tx.poll.delete({ where: { id } });
      await this.log(tx, p, "poll.delete", id, { question: poll.question });
      return { id, deleted: true as const };
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
      // The read above cannot enforce one-vote-per-member — at READ COMMITTED
      // two clicks both see no vote. The BALLOT IS SAFE regardless, because
      // `@@unique([pollId, voterId])` really exists in the database (checked,
      // not assumed): the second insert is refused by Postgres. What it is not
      // is a 500, which is what an unhandled P2002 reaching the client looks
      // like to somebody who simply double-clicked.
      try {
        await tx.pollVote.create({ data: { schoolId: p.schoolId, pollId, optionId, voterId: p.userId } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new BadRequestException("You have already voted in this poll");
        }
        throw e;
      }
      // Audit records ONLY that this member voted — never which option.
      // SYSTEM actor: a vote must not be attributable — see logAs.
      await this.logAs(tx, SYSTEM_ACTOR_ID, p.schoolId, "poll.vote", pollId, {});
      return this.pollDto(tx, pollId, p);
    });
  }

  // --- reads ----------------------------------------------------------------

  /** Polls visible to the caller (their audience), newest first. */
  async listPolls(p: Principal, opts: { cursor?: string; limit?: number } = {}): Promise<PageDto<PollDto>> {
    const limit = pageLimit(opts.limit);
    const cursor = decodeCursor(opts.cursor);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const audiences = [...this.callerAudiences(p)];
      // Staff/creator see all polls; others see only polls for their audience.
      const where = this.canManage(p) ? {} : { audience: { in: audiences } };
      const rows = (await tx.poll.findMany({
        where: { ...where, ...seekWhere(cursor) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      })) as PollRow[];
      const page = toPage(rows, limit);
      const polls = page.items;
      if (polls.length === 0) return { items: [], nextCursor: null };
      // Batch every lookup (was 6 queries per poll via pollDto — up to ~1200 for
      // a full page). ANONYMITY is preserved: the tally groups by
      // (pollId, optionId) only; voterId is never read into a tally.
      const pollIds = polls.map((x) => x.id);
      const options = (await tx.pollOption.findMany({
        where: { pollId: { in: pollIds } },
        orderBy: { sequence: "asc" },
      })) as OptionRow[];
      const creators = await tx.user.findMany({
        where: { id: { in: [...new Set(polls.map((x) => x.createdById))] } },
        select: { id: true, name: true },
      });
      const nameOf = new Map(creators.map((u: { id: string; name: string }) => [u.id, u.name]));
      // The caller's OWN votes only — this is the one place voterId is used, and
      // it reveals nothing about anyone else.
      const mine = await tx.pollVote.findMany({ where: { pollId: { in: pollIds }, voterId: p.userId }, select: { pollId: true } });
      const voted = new Set(mine.map((v: { pollId: string }) => v.pollId));
      const grouped = (await tx.pollVote.groupBy({
        by: ["pollId", "optionId"],
        where: { pollId: { in: pollIds } },
        _count: { _all: true },
      } as never)) as unknown as Array<{ pollId: string; optionId: string; _count: { _all: number } }>;
      const tallies = new Map<string, Map<string, number>>();
      const totals = new Map<string, number>();
      for (const g of grouped) {
        const m = tallies.get(g.pollId) ?? new Map<string, number>();
        m.set(g.optionId, g._count._all);
        tallies.set(g.pollId, m);
        totals.set(g.pollId, (totals.get(g.pollId) ?? 0) + g._count._all);
      }
      const optsByPoll = new Map<string, OptionRow[]>();
      for (const o of options) optsByPoll.set(o.pollId, [...(optsByPoll.get(o.pollId) ?? []), o]);
      const manage = this.canManage(p);
      const items = polls.map((poll) =>
        mapPollDto(
          poll,
          optsByPoll.get(poll.id) ?? [],
          nameOf.get(poll.createdById) ?? "",
          voted.has(poll.id),
          tallies.get(poll.id) ?? new Map(),
          totals.get(poll.id) ?? 0,
          manage || poll.createdById === p.userId,
        ),
      );
      return { items, nextCursor: page.nextCursor };
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

    void resultsVisible; // recomputed identically inside the shared mapper
    return mapPollDto(
      poll as PollRow,
      options as OptionRow[],
      creator?.name ?? "",
      hasVoted,
      tallyByOption,
      totalVotes,
      this.canManage(p) || poll.createdById === p.userId,
    );
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.logAs(tx, p.userId, p.schoolId, action, entityId, metadata);
  }

  /**
   * Audit under an explicit actor — the SYSTEM actor for a vote.
   *
   * A poll is anonymous by construction: the tally groups by option and voterId
   * is never read. Recording the voter on the audit row put the participant list
   * back, under a screen the same leadership can open. It reveals less than the
   * form case did (which option you chose is not in the row) but it is the same
   * mistake: a poll on confidence in leadership, with the roll of who answered
   * it available to leadership, is not an anonymous poll — and in a small
   * cohort, participation plus the tally can be enough on its own.
   */
  private logAs(
    tx: TenantTx,
    actorId: string,
    schoolId: string,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.record({ actorId, action, entity: "poll", entityId, schoolId, metadata }, tx);
  }
}

type PollRow = {
  id: string;
  question: string;
  audience: string;
  status: string;
  createdById: string;
  closesAt: Date | null;
  createdAt: Date;
};
type OptionRow = { id: string; pollId: string; label: string };

/**
 * Pure poll-row → DTO. Options, the creator's name, the caller's own has-voted
 * flag and the (pollId, optionId) tally are supplied by the caller — fetched once
 * for a single poll or batched across the page — so listing never fans out.
 *
 * `privileged` = staff/creator, who may see results at any time; everyone else
 * only once the poll has closed. A live voter never sees tallies, which keeps
 * in-progress voting blind, and per-option counts are zeroed when hidden.
 */
function mapPollDto(
  poll: PollRow,
  options: OptionRow[],
  createdByName: string,
  hasVoted: boolean,
  tallyByOption: Map<string, number>,
  totalVotes: number,
  privileged: boolean,
): PollDto {
  const isClosed = poll.status === "CLOSED" || (poll.closesAt ? poll.closesAt.getTime() < Date.now() : false);
  const resultsVisible = privileged || isClosed;
  return {
    id: poll.id,
    question: poll.question,
    audience: poll.audience,
    status: isClosed ? "CLOSED" : poll.status,
    createdById: poll.createdById,
    createdByName,
    closesAt: poll.closesAt,
    options: options.map((o) => ({
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
