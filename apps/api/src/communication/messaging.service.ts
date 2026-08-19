// =============================================================================
// MessagingService — threaded two-way messages, participant-scoped
// =============================================================================
import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";
import { type AuditLogService } from "../foundation/audit-log.service";
import { Prisma } from "@sms/db";
import { decodeCursor, pageLimit, seekWhere, toPage } from "../common/keyset-cursor";

// =============================================================================
// Who may START a conversation with whom
// =============================================================================
// The rule was: a "staff" sender may write to anyone, everyone else may write
// only to staff/teachers. But STAFF was `{school_admin, principal}` — two roles
// — and a TEACHER was not one of them. So a teacher could not write to a pupil
// they teach, or to that pupil's parent; nor could the bursar chasing a fee, or
// the librarian chasing a book. Only the principal and the school admin could
// reach a family at all.
//
// Families could always write TO teachers, and teachers could reply inside a
// thread a parent had opened. So the module was one-way in practice: a teacher
// could answer a parent but never raise anything with them. That is the wrong
// half of a parent-teacher relationship to support, and it is not what the rule
// was meant to say — a teacher IS staff by any ordinary reading of it.
//
// The replacement is the platform's own model everywhere else: coarse role, then
// a RELATIONSHIP narrows the rows.
//   * school-wide staff        -> anyone in the school
//   * a teacher                -> staff, their OWN pupils, and those pupils'
//                                 guardians. Deliberately not every child in the
//                                 school: an adult opening a channel to a minor
//                                 they have no connection to is exactly what
//                                 relationship scoping is for (Golden Rule #5).
//   * finance staff            -> staff and GUARDIANS (adults). They already see
//                                 every family's invoice; being unable to write
//                                 to the parent whose debt they are chasing was
//                                 the same gap. No pupils.
//   * everyone else            -> staff and teachers, as before.
const SCHOOL_WIDE_SENDERS = new Set(["school_admin", "principal"]);
/** Staff who deal with families' money school-wide, but never with pupils. */
const GUARDIAN_WIDE_SENDERS = new Set(["accountant"]);
/** Staff whose reach over pupils comes from the classes they actually teach. */
const CLASS_SCOPED_SENDERS = new Set(["teacher", "head_teacher"]);
/**
 * Staff whose reach over pupils comes from the HOSTEL they run.
 *
 * The same argument the class scope is built on. A boarder's warden is the adult
 * responsible for them overnight, and had no channel to that child or to their
 * parents — nor they to the warden — so a boarding school's most immediate
 * pastoral relationship was the one relationship the module did not model. A
 * warden reaches their OWN hostels; head_warden reaches every hostel, which is
 * exactly the scope that role already has everywhere else.
 */
const HOSTEL_SCOPED_SENDERS = new Set(["warden", "head_warden"]);

/**
 * Who a pupil or a parent may open a channel to.
 *
 * This was six roles, and it silently decided that a family could not write to
 * the head teacher, the school office, the librarian or their child's warden —
 * several of whom could write to THEM. A one-way pastoral relationship is the
 * same defect this module was already fixed for once, on the teacher side.
 *
 * The set is deliberately about a PASTORAL OR OFFICE relationship with families,
 * not about seniority: the test is whether a parent or pupil has ordinary
 * business with that person.
 */
const REACHABLE_BY_ANYONE = new Set([
  "teacher",
  "head_teacher",
  "school_admin",
  "principal",
  "head_admin",
  "junior_admin",
  "accountant",
  "hr_clerk",
  "board",
  "librarian",
  "warden",
  "head_warden",
]);

/**
 * Additionally reachable by GUARDIANS only.
 *
 * head_driver runs the fleet and is the right person to ask where a bus is —
 * a real parent need. It is NOT in the set above, because that would hand every
 * child in the school a private channel to transport staff, and a driver has no
 * pastoral relationship with a pupil to justify one. `driver` itself is
 * read-only over a single vehicle and is a contact point for nobody.
 *
 * // SECURITY: this is the one place the two audiences differ, and the reason
 * // they are separate sets rather than one list with a comment.
 */
const REACHABLE_BY_GUARDIANS = new Set(["head_driver"]);
/** Safety cap on messages returned for a single thread (most-recent-first). */
const MESSAGE_PAGE = 500;
// REMOVED: THREAD_SCAN_CAP (2000). It bounded a pre-fetch of the caller's
// participant rows, and its comment claimed "a member with more threads than
// this pages through the newest ones" — which is exactly what it did NOT do.
// The query had no orderBy, so the threads it kept were arbitrary: on a
// 2,600-thread inbox the 600 it dropped were scattered, including the
// 14th-newest conversation. Membership is now a JOIN in listThreads and
// searchMessages, so both are bounded by the page and correct at any size.
// Do not reintroduce a cap here: the fix for a big inbox is pagination, and it
// already has it.
/** Cap on the contact picker; `q` narrows it in a large school. */
const CONTACT_PAGE = 200;

@Injectable()
export class MessagingService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    private readonly notifications: NotificationService,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /**
   * Users the caller may start a thread with (staff: everyone; else only
   * staff/teachers). The eligibility rule is applied IN SQL and the result is
   * capped — this used to load every user in the school with their roles and
   * then throw most of them away in memory, which grows linearly with the roll
   * and is the kind of query that makes a big school's compose box crawl.
   * `q` narrows by name so a large school stays usable.
   */
  async contacts(p: Principal, q?: string) {
    const term = (q ?? "").trim();
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const scope = await this.recipientScope(tx, p);
      const users = await tx.user.findMany({
        where: {
          id: { not: p.userId },
          ...(scope ?? {}),
          ...(term ? { name: { contains: term, mode: Prisma.QueryMode.insensitive } } : {}),
        },
        select: { id: true, name: true, roles: { select: { role: { select: { name: true } } } } },
        orderBy: { name: "asc" },
        take: CONTACT_PAGE,
      });
      return (users as Array<{ id: string; name: string; roles: { role: { name: string } }[] }>).map((u) => ({
        id: u.id,
        name: u.name,
        roles: u.roles.map((r) => r.role.name),
      }));
    });
  }


  /**
   * The Prisma `where` that describes exactly who this caller may open a thread
   * with — `null` meaning "anyone in the school".
   *
   * ONE definition, consumed by BOTH the compose picker and the send guard. They
   * were separate expressions of the same rule before, which is the shape that
   * lets a list offer someone the send then refuses (or, worse, hides someone
   * the send would allow).
   */
  private async recipientScope(tx: TenantTx, p: Principal): Promise<Prisma.UserWhereInput | null> {
    if (p.roles.some((r) => SCHOOL_WIDE_SENDERS.has(r))) return null;

    // A guardian may also reach transport; a pupil may not. Everyone gets the
    // pastoral/office set.
    const isGuardian = p.roles.includes("parent");
    const reachable = [...REACHABLE_BY_ANYONE, ...(isGuardian ? REACHABLE_BY_GUARDIANS : [])];
    const staffOrTeacher: Prisma.UserWhereInput = {
      roles: { some: { role: { name: { in: reachable } } } },
    };
    const anyOf: Prisma.UserWhereInput[] = [staffOrTeacher];

    // Finance: every guardian, because they already see every family's invoice.
    if (p.roles.some((r) => GUARDIAN_WIDE_SENDERS.has(r))) {
      anyOf.push({ parentLinks: { some: {} } });
    }

    // A teacher's own pupils, and those pupils' guardians.
    if (p.roles.some((r) => CLASS_SCOPED_SENDERS.has(r))) {
      const [taught, supervised, subjectTaught] = await Promise.all([
        tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } }),
        tx.class.findMany({ where: { supervisorId: p.userId }, select: { id: true } }),
        tx.classSubjectTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } }),
      ]);
      const classIds = [
        ...new Set([
          ...taught.map((c: { classId: string }) => c.classId),
          ...supervised.map((c: { id: string }) => c.id),
          ...subjectTaught.map((c: { classId: string }) => c.classId),
        ]),
      ];
      if (classIds.length) {
        // ACTIVE enrolment only: a pupil who has left is no longer theirs to write to.
        const pupils = await tx.enrollment.findMany({
          where: { classId: { in: classIds }, status: "ACTIVE" },
          select: { studentId: true },
          distinct: ["studentId"],
        });
        const studentIds = pupils.map((e: { studentId: string }) => e.studentId);
        if (studentIds.length) {
          anyOf.push({ id: { in: studentIds } });
          anyOf.push({ parentLinks: { some: { studentId: { in: studentIds } } } });
        }
      }
    }

    // A warden's own boarders, and those boarders' guardians.
    if (p.roles.some((r) => HOSTEL_SCOPED_SENDERS.has(r))) {
      // ONE query. The hostel is reached through the room rather than by loading
      // hostels, then rooms, then allocations — three round trips to answer a
      // question the database can answer in one. head_warden has every hostel,
      // so their filter is on the school (which RLS already applies) rather than
      // on wardenId.
      const boarders = (await tx.hostelAllocation.findMany({
        where: {
          status: "ACTIVE",
          ...(p.roles.includes("head_warden") ? {} : { room: { hostel: { wardenId: p.userId } } }),
        },
        select: { studentId: true },
        distinct: ["studentId"],
      })) as Array<{ studentId: string }>;
      const boarderIds = boarders.map((b) => b.studentId);
      if (boarderIds.length) {
        anyOf.push({ id: { in: boarderIds } });
        anyOf.push({ parentLinks: { some: { studentId: { in: boarderIds } } } });
      }
    }

    return { OR: anyOf };
  }

  /** The caller's threads, newest activity first, keyset-paginated. */
  async listThreads(p: Principal, opts: { cursor?: string; limit?: number } = {}) {
    const limit = pageLimit(opts.limit);
    const cursor = decodeCursor(opts.cursor);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // MEMBERSHIP IS A FILTER, NOT A PRE-FETCH.
      //
      // This used to read the caller's participant rows first — `take: 2000`,
      // with NO orderBy — and then page threads within whatever that returned.
      // Anyone in more than 2,000 threads therefore had the rest made
      // permanently invisible, and "whatever Postgres returned" is not "the
      // most recent": measured on a 2,600-thread inbox, paging to the very end
      // yielded exactly 2,000 and the 600 missing ones were SCATTERED, the
      // 14th-newest conversation among them. Nothing in the response said so —
      // the last page just ended.
      //
      // Filtering on the relation instead lets Postgres do the join, so the
      // read is bounded by the PAGE and correct for any inbox size. The
      // participant rows are then fetched for the page only, which is where
      // lastReadAt is actually needed.
      const rows = (await tx.messageThread.findMany({
        where: { participants: { some: { userId: p.userId } }, ...seekWhere(cursor) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      })) as Array<{ id: string; subject: string; updatedAt: Date; createdAt: Date }>;
      const page = toPage(rows, limit);
      if (page.items.length === 0) return { items: [], nextCursor: null };
      const lastRead = new Map(
        (
          await tx.threadParticipant.findMany({
            where: { userId: p.userId, threadId: { in: page.items.map((t) => t.id) } },
            select: { threadId: true, lastReadAt: true },
          })
        ).map((x: { threadId: string; lastReadAt: Date | null }) => [x.threadId, x.lastReadAt]),
      );

      // Batch the per-thread work that used to be 2 queries EACH (a findFirst for
      // the last message + a count for unread) — that is what made a busy inbox
      // crawl. Newest message per thread comes from one DISTINCT ON; unread
      // counts from one groupBy.
      const pageIds = page.items.map((t) => t.id);
      const lastMsgs = await tx.$queryRaw<
        Array<{ threadId: string; id: string; senderId: string; body: string; createdAt: Date }>
      >`
        SELECT DISTINCT ON ("threadId") "threadId", id, "senderId", body, "createdAt"
        FROM "message"
        WHERE "threadId" = ANY(${pageIds}::uuid[])
        ORDER BY "threadId", "createdAt" DESC
      `;
      const lastOf = new Map(lastMsgs.map((m) => [m.threadId, m]));
      // Unread = messages from OTHERS newer than this participant's own
      // lastReadAt. Each thread has a different cutoff, so those cutoffs are
      // folded into a single OR'd predicate — one grouped count for the whole
      // page instead of a count per thread.
      const unreadRows = (await tx.message.groupBy({
        by: ["threadId"],
        where: {
          senderId: { not: p.userId },
          OR: pageIds.map((tid) => {
            const lr = lastRead.get(tid);
            return lr ? { threadId: tid, createdAt: { gt: lr } } : { threadId: tid };
          }),
        },
        _count: { _all: true },
      } as never)) as unknown as Array<{ threadId: string; _count: { _all: number } }>;
      const unreadOf = new Map(unreadRows.map((u) => [u.threadId, u._count._all]));

      return {
        items: page.items.map((t) => ({ ...t, lastMessage: lastOf.get(t.id) ?? null, unread: unreadOf.get(t.id) ?? 0 })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * Full-text search across the messages in the caller's OWN threads.
   * Postgres FTS (GIN-indexed on to_tsvector(body)) rather than ILIKE '%x%',
   * which cannot use an index and degrades linearly as history accumulates.
   * Participation is enforced by restricting to the caller's thread ids, and RLS
   * scopes the tenant underneath.
   */
  async searchMessages(p: Principal, q: string, limit = 30) {
    const term = (q ?? "").trim();
    if (term.length < 2) return [];
    const capped = Math.min(Math.max(1, limit), 50);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Same fix as listThreads: JOIN the membership rather than pre-fetching a
      // capped list of thread ids. Searching "the first 2,000 threads Postgres
      // happened to return" is a search that quietly cannot find things, which
      // is worse than one that is slow — the caller reads "no matches" and
      // concludes the message does not exist.
      return tx.$queryRaw<Array<{ id: string; threadId: string; senderId: string; body: string; createdAt: Date; subject: string }>>`
        SELECT m.id, m."threadId", m."senderId", m.body, m."createdAt", t.subject
        FROM "message" m
        JOIN "message_thread" t ON t.id = m."threadId"
        JOIN "thread_participant" tp ON tp."threadId" = t.id AND tp."userId" = ${p.userId}::uuid
        WHERE to_tsvector('english', m.body) @@ plainto_tsquery('english', ${term})
        ORDER BY m."createdAt" DESC
        LIMIT ${capped}
      `;
    });
  }

  async getThread(p: Principal, threadId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertParticipant(tx, p, threadId);
      // Bound the read: return the most-recent MESSAGE_PAGE messages (fetched
      // newest-first, then restored to chronological order) so a pathologically
      // long thread can't load its entire history into one response. Normal
      // school threads are far under the cap; if a thread ever exceeds it, this
      // is the seam to add an older-messages "load more" cursor.
      const [thread, recent] = await Promise.all([
        tx.messageThread.findFirst({ where: { id: threadId } }),
        tx.message.findMany({ where: { threadId }, orderBy: { createdAt: "desc" }, take: MESSAGE_PAGE }),
      ]);
      const messages = recent.reverse();
      // assertParticipant guarantees the thread exists; satisfy the type.
      if (!thread) throw new NotFoundException("Thread not found");
      await tx.threadParticipant.updateMany({
        where: { threadId, userId: p.userId },
        data: { lastReadAt: new Date() },
      });
      return { thread, messages };
    });
  }

  async createThread(p: Principal, input: { recipientId: string; subject: string; body: string }) {
    const thread = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanMessage(tx, p, input.recipientId);
      const t = await tx.messageThread.create({
        data: { schoolId: p.schoolId, subject: input.subject, createdById: p.userId },
      });
      await tx.threadParticipant.create({ data: { schoolId: p.schoolId, threadId: t.id, userId: p.userId, lastReadAt: new Date() } });
      await tx.threadParticipant.create({ data: { schoolId: p.schoolId, threadId: t.id, userId: input.recipientId } });
      await tx.message.create({ data: { schoolId: p.schoolId, threadId: t.id, senderId: p.userId, body: input.body } });

      // WHO OPENED A PRIVATE LINE TO WHOM. Recorded here and not on each reply:
      // `message` rows are append-only in practice — this service has no update
      // or delete path for them — so what was SAID is already durable and an
      // audit row per reply would be volume without information. What was not
      // recoverable was the act of starting the channel, and that is the one an
      // investigator begins from.
      //
      // `recipientIsStudent` is stamped rather than left to a join because the
      // safeguarding question — which adults opened channels with which children
      // — should be one query, and because a pupil who later leaves may lose the
      // role that would have answered it retrospectively.
      const recipientRoles = await tx.userRole.findMany({
        where: { userId: input.recipientId },
        select: { role: { select: { name: true } } },
      });
      const recipientIsStudent = (recipientRoles as Array<{ role: { name: string } }>).some(
        (r) => r.role.name === "student",
      );
      await this.audit.record(
        {
          actorId: p.userId,
          action: "message.thread.create",
          entity: "message_thread",
          entityId: t.id,
          schoolId: p.schoolId,
          // The SUBJECT only — never the body. An audit log is read by people
          // with no business reading the correspondence itself.
          metadata: { recipientId: input.recipientId, recipientIsStudent, subject: input.subject },
        },
        tx,
      );
      return { thread: t, recipientId: input.recipientId, subject: input.subject };
    });
    await this.notify(p, [thread.recipientId], thread.subject);
    return thread.thread;
  }

  async reply(p: Principal, threadId: string, body: string) {
    const res = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertParticipant(tx, p, threadId);
      const msg = await tx.message.create({ data: { schoolId: p.schoolId, threadId, senderId: p.userId, body } });
      await tx.messageThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });
      await tx.threadParticipant.updateMany({ where: { threadId, userId: p.userId }, data: { lastReadAt: new Date() } });
      const others = await tx.threadParticipant.findMany({
        where: { threadId, userId: { not: p.userId } },
        select: { userId: true },
      });
      const thread = await tx.messageThread.findFirst({ where: { id: threadId }, select: { subject: true } });
      return { msg, recipients: others.map((o: { userId: string }) => o.userId), subject: thread?.subject ?? "Message" };
    });
    await this.notify(p, res.recipients, res.subject);
    return res.msg;
  }

  // --- helpers ---------------------------------------------------------------
  private async assertParticipant(tx: TenantTx, p: Principal, threadId: string) {
    const part = await tx.threadParticipant.findFirst({ where: { threadId, userId: p.userId }, select: { id: true } });
    if (!part) throw new NotFoundException("Thread not found");
  }

  private async assertCanMessage(tx: TenantTx, p: Principal, recipientId: string) {
    const recipient = await tx.user.findFirst({ where: { id: recipientId }, select: { id: true } });
    if (!recipient) throw new NotFoundException("Recipient not found");
    const scope = await this.recipientScope(tx, p);
    if (scope === null) return;
    // The SAME clause the picker filtered by, asked about one person. Anyone the
    // compose box offered passes here by construction.
    const allowed = await tx.user.findFirst({ where: { id: recipientId, ...scope }, select: { id: true } });
    if (allowed) return;
    // Say which rule was missed. "You can only message staff and teachers" was
    // shown to a teacher writing to their own pupil, and named the wrong reason;
    // it would now do the same to a warden writing to a boarder in a hostel that
    // is not theirs.
    const reach = p.roles.some((r) => CLASS_SCOPED_SENDERS.has(r))
      ? "the pupils you teach, and their parents"
      : p.roles.some((r) => HOSTEL_SCOPED_SENDERS.has(r))
        ? "the boarders in your hostel, and their parents"
        : null;
    throw new ForbiddenException(
      reach
        ? `You can message staff, ${reach}. This person is none of those — ask the school office to pass it on.`
        : "You can only message school staff.",
    );
  }

  private async notify(p: Principal, recipientIds: string[], subject: string) {
    try {
      for (const id of recipientIds) {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: id,
          type: "GENERIC",
          title: "New message",
          body: `You have a new message: "${subject}".`,
        });
      }
    } catch {
      /* best-effort */
    }
  }
}
