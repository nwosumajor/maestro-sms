import { SCHOLARSHIP_COUNT_CAP, SCHOLARSHIP_UNDECIDED_STATUSES } from "@sms/types";
import type {
  PublishedScholarshipResultsDto,
  ScholarshipApplicationPageDto,
  ScholarshipExamQuestionDto,
} from "@sms/types";
// =============================================================================
// ScholarshipAdminService — platform owner (super_admin), CROSS-TENANT
// =============================================================================
// The platform owner defines/funds programs (GLOBAL table) and reviews + awards
// applications across ALL schools. Program writes and the cross-tenant review
// queue use the PRIVILEGED client (bypasses RLS by design, like operator
// provisioning / retention). An AWARD disburses through the FEES ledger: a
// PaymentKind.SCHOLARSHIP payment posted against the student's open invoice in
// their own school — integer kobo, audited, never hard-deleted. Every action is
// audit-logged in the operator's own tenant.
// SECURITY (Golden Rule #8): the platform owner DECIDES; the snapshotted signals
// only inform the decision.
// =============================================================================

import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, type PrismaClient } from "@sms/db";
import {
  DISBURSABLE_AWARD_KINDS,
  MODULES,
  SCHOLARSHIP_MAX_AWARDS,
  SCHOLARSHIP_SCHOOL_PRIZE_MONTHS,
  SCHOLARSHIP_SCHOOL_PRIZE_PLAN,
  isDisbursableAwardKind,
  resolveRegion,
  scholarshipSubjectConcept,
  type ScholarshipApplicationDto,
  type ScholarshipProgramDto,
} from "@sms/types";
import { scholarshipSupervisorStage, uniqueEntityCode } from "@sms/types";
import { ModuleEntitlementService } from "../foundation/module-entitlement.service";
import { NotificationService } from "../notifications/notification.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { Inject } from "@nestjs/common";
import { toMinor } from "../common/money";
import { formatMoney } from "@sms/types";

/**
 * THE CURRENCY A SCHOLARSHIP IS DENOMINATED IN.
 *
 * A scholarship is funded by the PLATFORM, so its award is a platform figure —
 * the operator console's field was literally called `nairaToKobo`. The invoice
 * it lands on belongs to a SCHOOL, whose currency may be any of the catalogue.
 * Nothing compared the two.
 */
const AWARD_CURRENCY = "NGN";

/**
 * What happened when an award tried to reach the fees ledger.
 *
 * TWO WAYS TO SUCCEED, and they are different facts about a family's balance.
 * `INVOICE` moved an open bill down today. `CREDIT` put the money on the
 * pupil's credit ledger because there was no open invoice at the moment the
 * award was decided — which is the ORDINARY case, since an award is often
 * granted before a term's fees are raised, not an edge one.
 */
type DisbursementOutcome =
  | { ok: true; kind: "INVOICE"; paymentId: string; amountMinor: number }
  | { ok: true; kind: "CREDIT"; creditEntryId: string; amountMinor: number }
  | { ok: false; reason: "nothing_outstanding" }
  | { ok: false; reason: "currency_mismatch"; invoiceCurrency: string }
  | { ok: false; reason: "school_bills_another_currency"; schoolCurrency: string };

interface ProgramInput {
  title: string;
  description?: string | null;
  budgetMinor: number;
  awardMinor: number;
  awardKind?: string;
  selectionBasis?: string;
  eligibility?: unknown;
  opensAt: string;
  closesAt: string;
  status?: string;
  /** GENERAL_SCIENCE | ART | COMMUNITY_DEVELOPMENT | MATHEMATICS | SPECIAL. */
  category?: string;
  /** Qualification exam: ONLINE_CBT | GAMES | PHYSICAL (+ date + venue text). */
  examMode?: string | null;
  examAt?: string | null;
  examVenue?: string | null;
  /** Per-position prizes (kobo) — 2nd/3rd fall back to awardMinor when null. */
  award2Minor?: number | null;
  award3Minor?: number | null;
  examDurationMin?: number;
  /** Owner-authored CBT question set. */
  examQuestions?: Array<{ text: string; options: string[]; answerIndex: number; subject?: string | null }> | null;
  examSchedule?: Record<string, { examAt: string; durationMin?: number }> | null;
  /** Append a single CBT question (the console adds them one at a time). */
  appendQuestion?: { text: string; options: string[]; answerIndex: number };
}

/**
 * How much of a published result set is public.
 *
 * BOUNDED at both levels, because this is read by every school on the platform
 * and grows with the platform's whole history: the newest programmes, and the
 * top rows of each. An unbounded cross-tenant read is the O(lifetime) shape
 * this repo keeps finding.
 */
const PUBLISHED_RESULTS_PROGRAMS = 10;
const PUBLISHED_RESULTS_ROWS = 50;

/**
 * The papers a programme examines, derived from its questions.
 *
 * A question naming no subject belongs to the programme's own CATEGORY, so a
 * programme written before subjects existed produces exactly the one paper it
 * always did — the generalisation costs nothing to anything already authored.
 *
 * Returns a stable order (first appearance), because the candidate's list of
 * papers and the operator's should not reshuffle between reads.
 */
/**
 * What one paper is called.
 *
 * A single-subject programme keeps EXACTLY the title it always had, so nothing
 * already announced is renamed and the idempotent lookup below still finds it.
 * A multi-subject one names the paper, because a candidate with three of them
 * needs to tell which is which.
 */
export function examTitleFor(programTitle: string, subject: string, paperCount: number): string {
  return paperCount <= 1 ? `Scholarship exam — ${programTitle}` : `Scholarship exam — ${programTitle} (${subject})`;
}

export function groupQuestionsBySubject<T extends { subject?: string | null }>(
  questions: T[],
  fallbackSubject: string,
): Array<{ subject: string; questions: T[] }> {
  const order: string[] = [];
  const bySubject = new Map<string, T[]>();
  for (const q of questions) {
    const subject = (q.subject ?? "").trim() || fallbackSubject;
    if (!bySubject.has(subject)) {
      bySubject.set(subject, []);
      order.push(subject);
    }
    bySubject.get(subject)!.push(q);
  }
  return order.map((subject) => ({ subject, questions: bySubject.get(subject)! }));
}

/** Who is told about a prize the SCHOOL won — the people who run it. */
const SCHOOL_PRIZE_RECIPIENTS = ["principal", "school_admin"] as const;

/** "1st" / "2nd" / "3rd", for a sentence a person reads. */
function ordinalPosition(position: number): string {
  return position === 1 ? "1st" : position === 2 ? "2nd" : position === 3 ? "3rd" : `${position}th`;
}

@Injectable()
export class ScholarshipAdminService {
  private readonly logger = new Logger("Scholarship");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
    // Which product modules a school actually has. @Global, 10-minute cache,
    // invalidated across tasks on any entitlement write.
    private readonly modules: ModuleEntitlementService,
  ) {}

  private client(): PrismaClient {
    const c = this.privileged.client;
    if (!c) throw new ServiceUnavailableException("Scholarship administration is not configured");
    return c;
  }

  // --- programs (global) -----------------------------------------------------
  async listPrograms(): Promise<ScholarshipProgramDto[]> {
    const rows = await this.client().scholarshipProgram.findMany({ orderBy: { createdAt: "desc" } });
    // ONE grouped query for every programme's committed spend, not one per row.
    const committed = new Map<string, number>(
      (
        (await this.client().scholarshipApplication.groupBy({
          by: ["programId"],
          where: { status: "AWARDED" },
          _sum: { awardMinor: true },
        } as never)) as unknown as Array<{ programId: string; _sum: { awardMinor: number | null } }>
      ).map((g) => [g.programId, g._sum.awardMinor ?? 0]),
    );
    return rows.map((r) => this.programDto(r, committed.get(r.id) ?? 0));
  }

  async createProgram(p: Principal, input: ProgramInput): Promise<ScholarshipProgramDto> {
    const opensAt = new Date(input.opensAt);
    const closesAt = new Date(input.closesAt);
    if (Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime())) throw new BadRequestException("invalid dates");
    if (closesAt <= opensAt) throw new BadRequestException("closesAt must be after opensAt");
    if (input.awardMinor <= 0) throw new BadRequestException("awardMinor must be positive");
    const row = await this.client().scholarshipProgram.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        budgetMinor: input.budgetMinor,
        awardMinor: input.awardMinor,
        awardKind: (input.awardKind ?? "FEES_CREDIT") as never,
        selectionBasis: (input.selectionBasis ?? "BOTH") as never,
        eligibility: (input.eligibility ?? null) as Prisma.InputJsonValue,
        opensAt,
        closesAt,
        status: (input.status ?? "DRAFT") as never,
        category: (input.category ?? "SPECIAL") as never,
        examMode: (input.examMode ?? null) as never,
        examAt: input.examAt ? new Date(input.examAt) : null,
        examVenue: input.examVenue ?? null,
        award2Minor: input.award2Minor ?? null,
        award3Minor: input.award3Minor ?? null,
        examDurationMin: input.examDurationMin ?? 30,
        examQuestions: (input.examQuestions ?? null) as Prisma.InputJsonValue,
        createdById: p.userId,
      },
    });
    await this.auditOwn(p, "scholarship.program.create", row.id, { title: input.title });
    return this.programDto(row);
  }

  async updateProgram(p: Principal, id: string, input: Partial<ProgramInput>): Promise<ScholarshipProgramDto> {
    const existing = await this.client().scholarshipProgram.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException("Program not found");
    const data: Prisma.ScholarshipProgramUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.budgetMinor !== undefined) data.budgetMinor = input.budgetMinor;
    if (input.awardMinor !== undefined) data.awardMinor = input.awardMinor;
    if (input.awardKind !== undefined) data.awardKind = input.awardKind as never;
    if (input.selectionBasis !== undefined) data.selectionBasis = input.selectionBasis as never;
    if (input.eligibility !== undefined) data.eligibility = (input.eligibility ?? null) as Prisma.InputJsonValue;
    if (input.opensAt !== undefined) data.opensAt = new Date(input.opensAt);
    if (input.closesAt !== undefined) data.closesAt = new Date(input.closesAt);
    if (input.status !== undefined) data.status = input.status as never;
    if (input.category !== undefined) data.category = input.category as never;
    if (input.examMode !== undefined) data.examMode = (input.examMode ?? null) as never;
    if (input.examAt !== undefined) data.examAt = input.examAt ? new Date(input.examAt) : null;
    if (input.examVenue !== undefined) data.examVenue = input.examVenue ?? null;
    if (input.award2Minor !== undefined) data.award2Minor = input.award2Minor ?? null;
    if (input.award3Minor !== undefined) data.award3Minor = input.award3Minor ?? null;
    if (input.examDurationMin !== undefined) data.examDurationMin = input.examDurationMin;
    if (input.examQuestions !== undefined) data.examQuestions = (input.examQuestions ?? null) as Prisma.InputJsonValue;
    if (input.examSchedule !== undefined) data.examSchedule = (input.examSchedule ?? null) as Prisma.InputJsonValue;
    // Append one question to the existing set (the console adds them one by one;
    // answers are server-only so the client can't resend the whole array).
    if (input.appendQuestion) {
      const current = Array.isArray(existing.examQuestions) ? (existing.examQuestions as unknown[]) : [];
      data.examQuestions = [...current, input.appendQuestion] as unknown as Prisma.InputJsonValue;
    }
    const row = await this.client().scholarshipProgram.update({ where: { id }, data });
    await this.auditOwn(p, "scholarship.program.update", id, { status: input.status });
    return this.programDto(row);
  }

  // --- review queue (cross-tenant) -------------------------------------------
  /**
   * The cross-tenant review queue.
   *
   * GOLDEN RULE #5 — this read is AUDITED, and was not. It returns up to 500
   * applications from EVERY school with the pupil's name, their guardian's
   * name, and the `signals` snapshot: published grade average, attendance, and
   * outstanding fees. That is a minor's academic and financial record, read
   * across the tenant boundary by the platform.
   *
   * Every mutation on this service already logs through auditOwn, and the file
   * header above claims "every action is audit-logged in the operator's own
   * tenant" — the READ was the exception, and the controller passed `_p`, so
   * nothing even reached here to log with. Same shape as the fix to
   * OperatorUserService.listUsers.
   */
  async listApplications(
    p: Principal,
    filter: { status?: string; programId?: string; page?: number; pageSize?: number },
  ): Promise<ScholarshipApplicationPageDto> {
    const db = this.client();
    const where: Prisma.ScholarshipApplicationWhereInput = {};
    // Never show DRAFTs to the platform (they aren't submitted yet).
    where.status = filter.status ? (filter.status as never) : { not: "DRAFT" };
    if (filter.programId) where.programId = filter.programId;

    // OLDEST FIRST while a row is still undecided, newest first once it is
    // history. A review queue is worked from the FRONT — the longest wait is
    // the one that matters — and the old `take: 500` newest-first meant the
    // 4,500 an operator could not see were exactly the families who applied
    // first. A finished list is BROWSED, and recent is what you want there.
    const undecided =
      filter.status === undefined ||
      (SCHOLARSHIP_UNDECIDED_STATUSES as readonly string[]).includes(filter.status);
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));

    // COUNTS ARE CAPPED, THE PAGE IS NOT — the same rule the notification inbox
    // reached, for the same reason. A plain `count` walks every application the
    // platform has ever received: measured on a realistic decade (505,004 rows,
    // 5,000 of them still awaiting a decision) the unbounded total is 30 ms on
    // every page load and grows every year, while "10,000+" is as useful to read
    // as "417,231". Paging is NOT bounded by it — `hasMore` comes from fetching
    // one row past the page — so every application stays reachable.
    //
    // Counted in SQL over the caller's whole scope, never `rows.length`, which
    // can only ever describe the page. `undecidedTotal` is deliberately NOT
    // narrowed by the status filter: a count a filter can change is a count a
    // filter can hide, and it answers "is anyone waiting on us".
    // THE CAP IS APPLIED IN SQL, not by counting rows in Node — and measuring is
    // what settled that. A `findMany({ take: CAP })` and `.length` ships 10,000
    // ids through the ORM and measured 250-444 ms, WORSE than the unbounded
    // `count` it replaced; the same cap as a `LIMIT` inside a subquery stops the
    // index scan at the cap and costs 13 buffers and 2.4 ms, against 418 buffers
    // and 30 ms for the plain count.
    const cappedCount = async (sql: Prisma.Sql): Promise<number> => {
      const [row] = await db.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n
          FROM (SELECT 1 FROM "scholarship_application" WHERE ${sql} LIMIT ${SCHOLARSHIP_COUNT_CAP}) t`;
      return Number(row?.n ?? 0);
    };
    const statusSql = filter.status
      ? Prisma.sql`"status" = ${filter.status}::"ScholarshipApplicationStatus"`
      : Prisma.sql`"status" <> 'DRAFT'`;
    const programSql = filter.programId
      ? Prisma.sql` AND "programId" = ${filter.programId}::uuid`
      : Prisma.empty;
    const [total, undecidedTotal, rows] = await Promise.all([
      cappedCount(Prisma.sql`${statusSql}${programSql}`),
      cappedCount(
        Prisma.sql`"status" IN (${Prisma.join(SCHOLARSHIP_UNDECIDED_STATUSES.map((x) => Prisma.sql`${x}::"ScholarshipApplicationStatus"`))})${programSql}`,
      ),
      db.scholarshipApplication.findMany({
        where,
        // A tiebreak, or a row created in the same millisecond as another can
        // appear on two pages and another on none.
        orderBy: undecided
          ? [{ createdAt: "asc" }, { id: "asc" }]
          : [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        // One past the page: the only honest way to say "there is more" without
        // paying for a full count.
        take: pageSize + 1,
      }),
    ]);
    const hasMore = rows.length > pageSize;
    if (hasMore) rows.pop();
    // Log the VIEW before the early return, so an empty queue is recorded too —
    // "who looked, and when" is the question, and a search that found nothing
    // is still a search. Counts and filters only, never a pupil's name.
    await this.auditOwn(p, "scholarship.applications.view", filter.programId ?? "all", {
      count: rows.length,
      total,
      page,
      status: filter.status ?? null,
      programId: filter.programId ?? null,
      schools: [...new Set(rows.map((r) => r.schoolId))].length,
    });
    if (rows.length === 0) return { items: [], total, page, pageSize, undecidedTotal, hasMore, countCap: SCHOLARSHIP_COUNT_CAP };
    const programIds = [...new Set(rows.map((r) => r.programId))];
    const userIds = [...new Set(rows.flatMap((r) => [r.studentId, r.applicantId]))];
    const schoolIds = [...new Set(rows.map((r) => r.schoolId))];
    const [programs, users, schools] = await Promise.all([
      db.scholarshipProgram.findMany({
        where: { id: { in: programIds } },
        select: { id: true, title: true, awardMinor: true, examMode: true, examAt: true },
      }),
      db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
      db.school.findMany({ where: { id: { in: schoolIds } }, select: { id: true, name: true } }),
    ]);
    const prog = new Map(programs.map((pr) => [pr.id, pr]));
    const name = new Map(users.map((u) => [u.id, u.name]));
    const school = new Map(schools.map((s) => [s.id, s.name]));
    const items: ScholarshipApplicationDto[] = rows.map((r) => ({
      id: r.id,
      programId: r.programId,
      programTitle: prog.get(r.programId)?.title ?? "Scholarship",
      awardMinorOffered: prog.get(r.programId)?.awardMinor ?? 0,
      // Granted is not CREDITED — see the DTO. This is the operator's own
      // review queue, so it is the screen that most needs to say so.
      // EITHER LINK counts as disbursed. Reading only the payment id was true
      // while an award could reach nowhere else; an award held on the credit
      // ledger has moved real money and would have read "not yet credited".
      disbursed:
        r.status === "AWARDED" ? Boolean(r.disbursementPaymentId || r.disbursementCreditEntryId) : null,
      disbursementKind: r.disbursementPaymentId ? "INVOICE" : r.disbursementCreditEntryId ? "CREDIT" : null,
      schoolId: r.schoolId,
      schoolName: school.get(r.schoolId) ?? null,
      studentId: r.studentId,
      studentName: name.get(r.studentId) ?? "Student",
      applicantId: r.applicantId,
      applicantName: name.get(r.applicantId) ?? "Applicant",
      applicantRole: r.applicantRole,
      answers: r.answers ?? null,
      signals: (r.signals as ScholarshipApplicationDto["signals"]) ?? null,
      status: r.status,
      consentById: r.consentById,
      consentAt: r.consentAt,
      supervisorById: r.supervisorById,
      supervisorStage: scholarshipSupervisorStage(r),
      supervisorAt: r.supervisorAt,
      supervisorNote: r.supervisorNote,
      parentNote: r.parentNote,
      principalById: r.principalById,
      principalAt: r.principalAt,
      principalNote: r.principalNote,
      rejectedStage: r.rejectedStage,
      examMode: prog.get(r.programId)?.examMode ?? null,
      examAt: prog.get(r.programId)?.examAt ?? null,
      examScorePct: r.examScorePct,
      awardPosition: r.awardPosition,
      awardMinor: r.awardMinor,
      reviewNote: r.reviewNote,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    return { items, total, page, pageSize, undecidedTotal, hasMore, countCap: SCHOLARSHIP_COUNT_CAP };
  }

  // --- decisions -------------------------------------------------------------
  /** Advance an application: REVIEW (→UNDER_REVIEW), SHORTLIST, QUALIFY (the
   *  student becomes a candidate for the scholarship exam), REJECT, or AWARD.
   *  AWARD disburses a FEES_CREDIT via the Fees ledger and is CAPPED at the
   *  Best Three per program. Student + guardians are notified of every outcome. */
  /**
   * Move MANY applications through the queue in one request.
   *
   * A scholarship qualifies a cohort, not an individual: the exercise this was
   * written for qualifies 2,000 of 5,000 applicants. One call per application
   * is 2,000 requests, and the platform's OWN per-tenant limiter (1,200/min,
   * keyed on the caller's school — the platform org for the owner) refused 494
   * of the first 1,000 with a 429. Measured, not predicted. The same gap this
   * repo already closed for invoices, where "there was no batch way to issue a
   * batch".
   *
   * DECISIONS ONLY, NEVER AN AWARD. An award moves money, grants a school a
   * free tier and consumes one of three positions; it is step-up gated and
   * decided one pupil at a time on purpose. Bulk is for the funnel — review,
   * shortlist, qualify, reject — where the operator is sorting a cohort.
   */
  async decideBulk(
    p: Principal,
    ids: string[],
    action: "REVIEW" | "SHORTLIST" | "QUALIFY" | "REJECT",
    note?: string,
  ): Promise<{ updated: number; skipped: Array<{ id: string; reason: string }> }> {
    const db = this.client();
    const nextStatus =
      action === "REVIEW" ? "UNDER_REVIEW" : action === "SHORTLIST" ? "SHORTLISTED" : action === "QUALIFY" ? "QUALIFIED" : "REJECTED";

    const rows = (await db.scholarshipApplication.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    })) as Array<{ id: string; status: string }>;
    const found = new Map(rows.map((r) => [r.id, r.status]));

    // PARTIAL SUCCESS IS REPORTED, NOT HIDDEN — and this is the opposite call
    // from the physical mark sheet next door, deliberately. A mark sheet is one
    // document where a missing name is invisible, so it refuses whole. This is a
    // SELECTION an operator made on screen, where "3 of 500 were already
    // rejected" is actionable and the other 497 should not wait on them.
    const skipped: Array<{ id: string; reason: string }> = [];
    const eligible: string[] = [];
    for (const id of ids) {
      const status = found.get(id);
      if (status === undefined) {
        skipped.push({ id, reason: "not found" });
      } else if (["DRAFT", "PENDING_SUPERVISOR", "PENDING_PARENT", "PENDING_PRINCIPAL"].includes(status)) {
        skipped.push({ id, reason: "has not completed its school approval chain" });
      } else if (status === "AWARDED" || status === "REJECTED") {
        skipped.push({ id, reason: "already finalised" });
      } else {
        eligible.push(id);
      }
    }

    // ONE statement, not one per application — the same reason `writeScores`
    // does a single UPDATE rather than a loop of round trips.
    const res =
      eligible.length === 0
        ? { count: 0 }
        : await db.scholarshipApplication.updateMany({
            where: { id: { in: eligible } },
            data: { status: nextStatus as never, reviewedById: p.userId, ...(note ? { reviewNote: note } : {}) },
          });

    // ONE audit row for the batch, carrying what was and was not done. A row per
    // application would bury the log for exactly the action that most needs to
    // be legible afterwards.
    await this.auditOwn(p, "scholarship.applications.decide-bulk", "bulk", {
      action,
      requested: ids.length,
      updated: res.count,
      skipped: skipped.length,
    });
    return { updated: res.count, skipped };
  }

  async decide(
    p: Principal,
    id: string,
    body: { action: "REVIEW" | "SHORTLIST" | "QUALIFY" | "REJECT" | "AWARD"; note?: string; awardMinor?: number; position?: number },
  ): Promise<ScholarshipApplicationDto> {
    const db = this.client();
    const app = await db.scholarshipApplication.findFirst({ where: { id } });
    if (!app) throw new NotFoundException("Application not found");
    const inChain = ["DRAFT", "PENDING_SUPERVISOR", "PENDING_PARENT", "PENDING_PRINCIPAL"].includes(app.status);
    if (inChain) throw new BadRequestException("This application has not completed its school approval chain");
    if (app.status === "AWARDED" || app.status === "REJECTED") {
      throw new BadRequestException("This application has already been finalised");
    }

    let disbursement: DisbursementOutcome | null = null;
    let nextStatus: string = app.status;
    if (body.action === "REVIEW") nextStatus = "UNDER_REVIEW";
    else if (body.action === "SHORTLIST") nextStatus = "SHORTLISTED";
    else if (body.action === "QUALIFY") nextStatus = "QUALIFIED";
    else if (body.action === "REJECT") nextStatus = "REJECTED";
    else if (body.action === "AWARD") {
      const program = await db.scholarshipProgram.findFirst({
        where: { id: app.programId },
        select: { title: true, awardMinor: true, award2Minor: true, award3Minor: true, awardKind: true, budgetMinor: true },
      });
      // Position 1|2|3 → the matching prize (2nd/3rd fall back to 1st when unset);
      // an explicit awardMinor override still wins. Each position granted ONCE.
      const position = body.position && [1, 2, 3].includes(body.position) ? body.position : 1;
      const positionAmount =
        position === 3 ? program?.award3Minor ?? program?.awardMinor ?? 0
        : position === 2 ? program?.award2Minor ?? program?.awardMinor ?? 0
        : program?.awardMinor ?? 0;
      const awardMinor = body.awardMinor ?? positionAmount;
      if (awardMinor <= 0) throw new BadRequestException("award amount must be positive");
      // AN AWARD THAT CANNOT BE PAID IS NOT AN AWARD. The disburse call below
      // is gated `if (awardKind === "FEES_CREDIT")` and has no other branch, so
      // a programme carrying SUBSCRIPTION_CREDIT marked the application
      // AWARDED, told the family they had won, spent one of the three
      // positions — and moved nothing, silently.
      //
      // Refused BEFORE the claim below, so nothing is marked and no position is
      // consumed. The boundary already refuses the kind on create and update;
      // this is the second layer, for a programme stored before it did.
      if (!isDisbursableAwardKind(program?.awardKind ?? "FEES_CREDIT")) {
        throw new BadRequestException(
          `This programme awards ${program?.awardKind}, which the platform cannot pay out — nothing would reach the school. ` +
            `Change the programme's award kind to ${DISBURSABLE_AWARD_KINDS.join(" or ")} before awarding.`,
        );
      }
      // Best Three: at most SCHOLARSHIP_MAX_AWARDS awards, and each POSITION once.
      const awardedRows = await db.scholarshipApplication.findMany({
        where: { programId: app.programId, status: "AWARDED" },
        select: { awardPosition: true, awardMinor: true },
      });
      if (awardedRows.length >= SCHOLARSHIP_MAX_AWARDS) {
        throw new BadRequestException(`This scholarship already has its best ${SCHOLARSHIP_MAX_AWARDS} awardees`);
      }
      if (awardedRows.some((a) => a.awardPosition === position)) {
        throw new BadRequestException(`The ${position === 1 ? "1st" : position === 2 ? "2nd" : "3rd"} position has already been awarded`);
      }
      // THE BUDGET WAS DECORATIVE. The operator is asked for one on the create
      // form, it is stored, it is shown back — and nothing ever compared it to
      // anything. A programme budgeted at 100,000 with three 50,000 prizes could
      // award 150,000 and nothing objected. A field that looks like a spending
      // control and constrains nothing is worse than no field: it is read as a
      // limit that is being observed.
      //
      // ZERO MEANS "NOT SET", not "spend nothing". It is the column default, so
      // enforcing it literally would refuse every award on every programme whose
      // budget was left blank.
      const budget = toMinor(program?.budgetMinor ?? 0);
      if (budget > 0) {
        const spent = awardedRows.reduce((sum, a) => sum + (a.awardMinor ?? 0), 0);
        if (spent + awardMinor > budget) {
          // formatMoney, never minor/100 — the CFA franc and ten other
          // currencies in the catalogue have no minor unit, and dividing prints
          // a figure a hundred times too small. The repo has a gate for this and
          // it caught the first version of this very message.
          const school = await db.school.findFirst({ where: { id: app.schoolId }, select: { currency: true } });
          const cur = school?.currency ?? "NGN";
          throw new BadRequestException(
            `This award of ${formatMoney(awardMinor, cur)} would take the programme past its budget — ` +
              `${formatMoney(spent, cur)} of ${formatMoney(budget, cur)} is already committed. ` +
              `Raise the budget or lower the award.`,
          );
        }
      }
      nextStatus = "AWARDED";
      // CLAIM THE AWARD BEFORE SPENDING ANYTHING.
      //
      // The status check at the top of this method is a READ. At READ COMMITTED
      // two awards of the same application both pass it, both disburse, and the
      // family is credited twice — the same read-then-write shape already
      // hardened on a library return and on every workflow transition, but on
      // the one path that moves money onto a child's fee account.
      //
      // The conditional update is the serialisation point: exactly one caller
      // gets count 1, and everything with a consequence happens after it.
      let claimed: { count: number };
      try {
        claimed = await db.scholarshipApplication.updateMany({
          where: { id, status: { notIn: ["AWARDED", "REJECTED"] } },
          data: { status: nextStatus as never, awardMinor, awardPosition: position, reviewedById: p.userId, reviewNote: body.note ?? null },
        });
      } catch (e) {
        // The position check above is a read across OTHER applications, which no
        // per-row claim can serialise. The database holds that invariant (partial
        // unique on programId + awardPosition where AWARDED), and this turns its
        // refusal into the sentence the read would have given rather than a 500 —
        // the pattern RecruitmentService.convert uses for a duplicate email.
        if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
          throw new BadRequestException(
            `The ${position === 1 ? "1st" : position === 2 ? "2nd" : "3rd"} position has already been awarded`,
          );
        }
        throw e;
      }
      if (claimed.count === 0) throw new BadRequestException("This application has already been finalised");
      // Disburse a fees credit into the student's OWN school (privileged; the
      // Payment carries the school's id so it's correctly tenant-owned).
      if ((program?.awardKind ?? "FEES_CREDIT") === "FEES_CREDIT") {
        disbursement = await this.disburseFeesCredit(db, app.schoolId, app.studentId, awardMinor, app.id, p.userId);
      }
      // AND THE WINNER'S SCHOOL IS AWARDED TOO. A scholarship rewards the pupil
      // with fees and the school that taught them with free ENTERPRISE: a
      // session for 1st, two terms for 2nd, one term for 3rd.
      await this.grantSchoolPrize(db, app.schoolId, position, program?.title ?? "a scholarship", p.userId);
      if (disbursement?.ok) {
        // Exactly one link is set, so a reader can always tell an award that
        // moved a bill from one waiting on the credit ledger.
        await db.scholarshipApplication.update({
          where: { id },
          data:
            disbursement.kind === "INVOICE"
              ? { disbursementPaymentId: disbursement.paymentId }
              : { disbursementCreditEntryId: disbursement.creditEntryId },
        });
      }
      // The audit row records WHY nothing was posted, not just that nothing was.
      // "disbursed: 0" is the same entry for a family with no open invoice and
      // for an award refused because it was denominated in another currency, and
      // only one of those needs somebody to act.
      await this.auditOwn(p, "scholarship.award", id, {
        targetSchoolId: app.schoolId,
        studentId: app.studentId,
        awardMinor,
        position,
        disbursed: disbursement?.ok ? disbursement.amountMinor : 0,
        // WHERE it went, not only how much. A credit held against a future bill
        // and a payment against an open one are different facts to reconcile.
        disbursedTo: disbursement?.ok ? disbursement.kind : null,
        notDisbursedReason: disbursement && !disbursement.ok ? disbursement.reason : null,
      });
      if (disbursement && !disbursement.ok && disbursement.reason === "school_bills_another_currency") {
        // Same class as the currency mismatch below, reached by the other door:
        // the pupil has no open invoice AND the school does not bill in the
        // award's currency, so a credit written here could never be spent.
        this.logger.error(
          `scholarship ${id}: award of ${formatMoney(awardMinor, AWARD_CURRENCY)} not posted — ` +
            `the school bills in ${disbursement.schoolCurrency} and a scholarship is denominated ` +
            `in ${AWARD_CURRENCY}. Post the credit manually in the school's own currency.`,
        );
      }
      if (disbursement && !disbursement.ok && disbursement.reason === "currency_mismatch") {
        // ERROR, not warn: an award has been granted and the money has not moved.
        // Recoverable — the application stands and the credit can be posted by
        // hand or after the award is re-denominated — but nothing else will
        // notice, so it must be loud where the platform's logs are read.
        this.logger.error(
          `scholarship ${id}: award of ${formatMoney(awardMinor, AWARD_CURRENCY)} not posted — ` +
            `the student's invoice is in ${disbursement.invoiceCurrency}, and a scholarship is ` +
            `denominated in ${AWARD_CURRENCY}. Post the credit manually in the school's own currency.`,
        );
      }
      const posLabel = position === 1 ? "1st" : position === 2 ? "2nd" : "3rd";
      await this.notifyFamily(
        p,
        app.schoolId,
        app.studentId,
        `🎉 Scholarship AWARDED (${posLabel} position) — “${program?.title ?? "Scholarship"}”`,
        // Never promise a credit that did not post. "It has been credited" sent a
        // family to check a balance that had not moved, and the two cases where
        // it legitimately does not post — no open invoice, nothing outstanding —
        // are good news that reads as a mistake when described wrongly.
        // THREE OUTCOMES, THREE SENTENCES. "Credited against the fees" is only
        // true when a bill actually moved; saying it of a credit held for the
        // next invoice sends a family to check a balance that has not changed.
        !disbursement?.ok
          ? `Congratulations on finishing in ${posLabel} position! The award has been granted; the school will apply it to the student's fees.`
          : disbursement.kind === "INVOICE"
            ? `Congratulations on finishing in ${posLabel} position! ${formatMoney(disbursement.amountMinor, AWARD_CURRENCY)} has been credited against the student's school fees.`
            : `Congratulations on finishing in ${posLabel} position! ${formatMoney(disbursement.amountMinor, AWARD_CURRENCY)} is being held as credit on the student's account and will come off the next school bill.`,
      );
      const [row] = await this.listApplicationById(db, id);
      return row;
    }

    await db.scholarshipApplication.update({
      where: { id },
      data: {
        status: nextStatus as never,
        reviewedById: p.userId,
        reviewNote: body.note ?? app.reviewNote,
        ...(body.action === "REJECT" ? { rejectedStage: "PLATFORM" } : {}),
      },
    });
    await this.auditOwn(p, `scholarship.${body.action.toLowerCase()}`, id, { targetSchoolId: app.schoolId, status: nextStatus });
    if (body.action === "QUALIFY") {
      const program = await db.scholarshipProgram.findFirst({ where: { id: app.programId }, select: { title: true } });
      await this.notifyFamily(
        p,
        app.schoolId,
        app.studentId,
        `Qualified for the scholarship exam — “${program?.title ?? "Scholarship"}”`,
        "The student is now a qualified candidate. The exam category, mode and date will be announced on the platform.",
      );
    } else if (body.action === "REJECT") {
      await this.notifyFamily(
        p,
        app.schoolId,
        app.studentId,
        "Scholarship application outcome",
        `The application was not successful at the sponsor's review.${body.note ? ` Note: ${body.note}` : ""}`,
      );
    }
    const [row] = await this.listApplicationById(db, id);
    return row;
  }

  /** Announce the qualification exam AND materialize the real sitting surface:
   *   ONLINE_CBT → one CbtQuestionBank + CbtExam per candidate's school, seeded
   *                from the program's owner-authored question set, scoped to
   *                that school and marked `scholarshipProgramId` so ONLY that
   *                school's QUALIFIED candidates can sit it (the CBT module gates
   *                on it). PUBLISHED, window = examAt … examAt+durationMin.
   *   GAMES      → one cross-school Ultimate arena competition tagged
   *                `scholarshipProgramId`; each candidate's school is enrolled
   *                and their guardian's chain-consent is written as an
   *                UltimateConsent, so entry passes the arena's own two-tier gate
   *                without needing the school's general crossSchoolEnabled flag.
   *   PHYSICAL   → notify only (no on-platform surface).
   *  Idempotent: re-announcing reuses existing exams/competition (no duplicates).
   *  Every candidate + guardians are notified with the mode, date and how to sit. */
  /**
   * Take an award back.
   *
   * There was no way out of AWARDED. `decide` refuses anything already awarded
   * as "finalised", the credit sits on the pupil's invoice as a POSTED payment,
   * and the position stays consumed — so an award granted to the wrong candidate
   * was permanent, and it cost one of only three places for the whole programme.
   * The partial unique index that now holds Best Three makes that sharper still:
   * the position cannot even be reassigned while the mistaken award holds it.
   *
   * The money is reversed by DOUBLE ENTRY, not by deleting anything: a REFUND
   * payment for exactly what was credited, which is how this platform already
   * moves an overpayment off an invoice. A financial record is never rewritten,
   * and the pair reads as what happened — credited, then taken back.
   *
   * The application returns to QUALIFIED rather than to a REVOKED dead end. The
   * mistake was the award, not the qualification: this candidate is still
   * eligible, and the position is freed for whoever should have had it.
   */
  async revokeAward(p: Principal, id: string, reason: string): Promise<ScholarshipApplicationDto> {
    const db = this.client();
    const app = await db.scholarshipApplication.findFirst({ where: { id } });
    if (!app) throw new NotFoundException("Application not found");
    if (app.status !== "AWARDED") throw new BadRequestException("Only an awarded scholarship can be taken back");

    // Claim it, for the same reason the award itself is claimed: two revocations
    // both reading AWARDED would each post a refund.
    const claimed = await db.scholarshipApplication.updateMany({
      where: { id, status: "AWARDED" },
      data: { status: "QUALIFIED" as never, awardPosition: null, awardMinor: null, disbursementPaymentId: null,
              // BOTH links, or a revoked award keeps reading as disbursed on the
              // funder's screen through the other one.
              disbursementCreditEntryId: null,
              reviewedById: p.userId, reviewNote: reason },
    });
    if (claimed.count === 0) throw new BadRequestException("This award has already been taken back");

    let refunded = 0;
    if (app.disbursementPaymentId) {
      const credit = await db.payment.findFirst({
        where: { id: app.disbursementPaymentId, status: "POSTED" },
        select: { id: true, invoiceId: true, amountMinor: true },
      });
      if (credit) {
        await db.payment.create({
          data: {
            schoolId: app.schoolId,
            invoiceId: credit.invoiceId,
            amountMinor: credit.amountMinor,
            method: "OTHER",
            kind: "REFUND",
            status: "POSTED",
            // Points back at the award it reverses, so the pair is legible in
            // the ledger without knowing this feature exists.
            reference: `SCHOLARSHIP-REVERSAL:${id}`,
            note: `Scholarship award taken back: ${reason}`,
            recordedById: p.userId,
          },
        });
        refunded = credit.amountMinor;
        // The invoice owes again. Recomputed from the ledger rather than assumed,
        // because other payments may have landed since the award.
        const posted = (await db.payment.findMany({
          where: { invoiceId: credit.invoiceId, status: "POSTED" },
          select: { amountMinor: true, kind: true },
        })) as Array<{ amountMinor: number; kind: string }>;
        const invoice = await db.invoice.findFirst({ where: { id: credit.invoiceId }, select: { totalMinor: true } });
        const net = posted.reduce((sum, x) => sum + (x.kind === "REFUND" ? -x.amountMinor : x.amountMinor), 0);
        await db.invoice.update({
          where: { id: credit.invoiceId },
          data: { status: net >= (invoice?.totalMinor ?? 0) ? "PAID" : net > 0 ? "PARTIALLY_PAID" : "ISSUED" },
        });
      }
    }

    // A CREDIT IS TAKEN BACK THE SAME WAY A PAYMENT IS.
    //
    // The arm above reverses an award that landed on an invoice. An award held
    // on the CREDIT LEDGER had no such arm, so revoking one nulled the link and
    // left the money — the family kept a balance for an award the platform had
    // withdrawn, and nothing anywhere said so.
    //
    // A NEGATIVE ENTRY, never a delete: this ledger is append-only in posture
    // and the pair reads as what happened. Idempotent on its own reference for
    // the same reason the award is.
    if (app.disbursementCreditEntryId) {
      const held = await db.studentCreditEntry.findFirst({ where: { id: app.disbursementCreditEntryId } });
      const reversalRef = `SCHOLARSHIP-REVERSAL:${id}`;
      const already = await db.studentCreditEntry.findFirst({
        where: { schoolId: app.schoolId, studentId: app.studentId, reference: reversalRef },
      });
      if (held && !already) {
        await db.studentCreditEntry.create({
          data: {
            schoolId: app.schoolId,
            studentId: app.studentId,
            deltaMinor: -held.deltaMinor,
            currency: held.currency,
            reason: "REFUNDED",
            reference: reversalRef,
            note: `Scholarship award taken back: ${reason}`,
            createdById: p.userId,
          },
        });
        refunded = held.deltaMinor;
      }
    }

    // THE SCHOOL'S HALF, taken back with the pupil's. `awardPosition` is nulled
    // by the claim above, so the position is read off the row as it stood.
    if (app.awardPosition) {
      const program = await db.scholarshipProgram.findFirst({
        where: { id: app.programId },
        select: { title: true },
      });
      await this.revokeSchoolPrize(db, app.schoolId, app.awardPosition, program?.title ?? "a scholarship", p.userId);
    }

    await this.auditOwn(p, "scholarship.award.revoke", id, {
      schoolPrizePositionReversed: app.awardPosition ?? null,
      targetSchoolId: app.schoolId, studentId: app.studentId, refunded, reason,
    });
    // The family was told they had won. They are told this too — silence after
    // that message is the worse failure.
    await this.notifyFamily(
      p,
      app.schoolId,
      app.studentId,
      "A scholarship award has been withdrawn",
      `${reason} Any fee credit applied has been reversed. Please contact the school office.`,
    );
    const [row] = await this.listApplicationById(db, id);
    return row;
  }

  async announceExam(
    p: Principal,
    programId: string,
  ): Promise<{ notified: number; cbtExams: number; arena: boolean }> {
    const db = this.client();
    const program = await db.scholarshipProgram.findFirst({ where: { id: programId } });
    if (!program) throw new NotFoundException("Program not found");
    if (!program.examMode || !program.examAt) {
      throw new BadRequestException("Set the exam mode and date on the program before announcing");
    }
    const candidates = await db.scholarshipApplication.findMany({
      where: { programId, status: "QUALIFIED" },
      select: { schoolId: true, studentId: true },
    });
    if (candidates.length === 0) throw new BadRequestException("No qualified candidates to announce to yet");

    const questions = Array.isArray(program.examQuestions)
      ? (program.examQuestions as unknown as Array<{ text: string; options: string[]; answerIndex: number; subject?: string | null }>)
      : [];
    // ONE PAPER PER SUBJECT, and the subjects are DERIVED from the questions
    // rather than kept in a second list. A paper therefore cannot exist with
    // nothing on it, and a subject cannot be silently dropped — there is no
    // other list for it to fall out of step with.
    //
    // A question with no subject belongs to the programme's own category, which
    // is exactly the single-paper behaviour this generalises: every programme
    // authored before now produces the same one paper it always did.
    const papers = groupQuestionsBySubject(questions, String(program.category));
    const schedule = (program.examSchedule ?? {}) as Record<string, { examAt?: string; durationMin?: number }>;
    /** When a subject's paper opens, and for how long. Falls back to the
     *  programme's own window for any subject with no entry. */
    const windowFor = (subject: string) => {
      const own = schedule[subject];
      const startAt = own?.examAt ? new Date(own.examAt) : program.examAt!;
      const minutes = own?.durationMin ?? program.examDurationMin ?? 30;
      return { startAt, minutes, endAt: new Date(startAt.getTime() + minutes * 60 * 1000) };
    };
    const examEnd = new Date(program.examAt.getTime() + (program.examDurationMin ?? 30) * 60 * 1000);
    const bySchool = new Map<string, string[]>();
    for (const c of candidates) {
      const arr = bySchool.get(c.schoolId) ?? [];
      arr.push(c.studentId);
      bySchool.set(c.schoolId, arr);
    }

    let cbtExams = 0;
    let arena = false;
    // EVERY QUALIFIED CANDIDATE CAN SIT, whatever their school pays for.
    //
    // This used to resolve each school's CBT entitlement and EXCLUDE the ones
    // without it, because the only way to sit was the `cbt` routes, a PREMIUM
    // module — a candidate there was notified and then met a 404. The scholarship
    // surface now serves the paper itself and is always-on, so that exclusion
    // became the thing standing between a qualified pupil and their exam: it
    // skipped creating their school's exam row, and with no row there is
    // nothing for them to open.
    //
    // Found by exercising the whole flow end to end after both changes landed —
    // one fix quietly cancelling the other is invisible in either one's tests.

    // --- ONLINE_CBT: a per-school exam seeded from the program's questions -----
    if (program.examMode === "ONLINE_CBT") {
      if (questions.length === 0) {
        throw new BadRequestException("Add CBT questions to the program before announcing an online CBT exam");
      }
      for (const [schoolId] of bySchool) {
       for (const paper of papers) {
        const { startAt, minutes, endAt } = windowFor(paper.subject);
        const title = examTitleFor(program.title, paper.subject, papers.length);
        // Idempotent per (program, school, PAPER). It used to key on
        // (program, school) alone, which was right while a programme had one
        // paper and would have made every subject after the first collide with
        // the one before it.
        const existing = await db.cbtExam.findFirst({
          where: { schoolId, scholarshipProgramId: programId, title },
        });
        if (existing) {
          await db.cbtExam.update({
            where: { id: existing.id },
            data: {
              startAt,
              endAt,
              durationMinutes: minutes,
              status: "PUBLISHED",
              // THE ANNOUNCE IS THE RELEASE for a PLATFORM exam. A school's own
              // scheduled exam waits for a day-of release by its principal or
              // head teacher; a scholarship exam has no school invigilator —
              // the platform owner set the window and owns the paper. Requiring
              // a school release made it unsittable in two ways at once: nobody
              // there is responsible for it, and the release route is inside
              // the PREMIUM CBT module the candidate's school may not have.
              releasedAt: new Date(),
            },
          });
          cbtExams += 1;
          continue;
        }
        // A bank MUST name a real Subject — teacher access is decided by subject,
        // so a subject-less bank is un-fillable by every teacher in the school.
        // The program's category is the subject; find-or-create it in each school
        // (privileged client, so this crosses into the tenant deliberately).
        const subjectName = paper.subject.replaceAll("_", " ");
        // Resolve by CONCEPT first, then by name case-insensitively, and only
        // then create.
        //
        // This used to match on the exact name and create one on a miss, which
        // splits a school's subject in two the moment its wording differs: a
        // francophone school holding "Mathématiques" (MTH) got a second
        // "Mathematics" row, and a school holding "MATHEMATICS" got another
        // still — after which grades for one subject land under two ids and the
        // report card silently shows half of them.
        const concept = scholarshipSubjectConcept(paper.subject);
        const rows = (await db.subject.findMany({
          where: { schoolId },
          select: { id: true, name: true, code: true, catalogueCode: true },
        })) as Array<{ id: string; name: string; code: string; catalogueCode: string | null }>;
        const wanted = subjectName.trim().toLowerCase();
        const subject =
          (concept ? rows.find((r) => r.catalogueCode === concept) : undefined) ??
          rows.find((r) => r.name.trim().toLowerCase() === wanted) ??
          (await db.subject.create({
            data: {
              schoolId,
              name: subjectName,
              code: uniqueEntityCode(subjectName, rows.map((r) => r.code)),
              // Stamp the concept so the NEXT school-side pick recognises it
              // rather than adding a twin from the other direction.
              catalogueCode: concept,
            },
            select: { id: true, name: true },
          }));
        const bank = await db.cbtQuestionBank.create({
          data: {
            schoolId,
            name: `Scholarship: ${title}`,
            subject: subject.name,
            subjectId: subject.id,
            createdById: p.userId,
          },
        });
        await db.cbtQuestion.createMany({
          data: paper.questions.map((q) => ({
            schoolId,
            bankId: bank.id,
            prompt: q.text,
            choices: q.options as unknown as Prisma.InputJsonValue,
            answerIndex: q.answerIndex,
          })),
        });
        await db.cbtExam.create({
          data: {
            schoolId,
            bankId: bank.id,
            title,
            questionCount: paper.questions.length,
            durationMinutes: minutes,
            startAt,
            endAt,
            status: "PUBLISHED",
            // See the reuse branch above: the announce IS the release here.
            releasedAt: new Date(),
            shuffle: true,
            scholarshipProgramId: programId,
            createdById: p.userId,
          },
        });
        cbtExams += 1;
       }
      }
    }

    // --- GAMES: one arena competition + per-candidate enrollment/consent -------
    if (program.examMode === "GAMES") {
      let comp = await db.ultimateCompetition.findFirst({ where: { scholarshipProgramId: programId } });
      if (!comp) {
        comp = await db.ultimateCompetition.create({
          data: {
            name: `Scholarship: ${program.title}`,
            difficultyLength: 5,
            status: "ACTIVE",
            startAt: program.examAt,
            endAt: examEnd,
            scholarshipProgramId: programId,
            createdById: p.userId,
          },
        });
      }
      for (const [schoolId, studentIds] of bySchool) {
        // Tier-1: enroll the school into THIS competition (idempotent).
        const enrolled = await db.ultimateEnrollment.findFirst({ where: { competitionId: comp.id, schoolId } });
        if (!enrolled) {
          await db.ultimateEnrollment.create({ data: { competitionId: comp.id, schoolId, enrolledById: p.userId } });
        }
        // Tier-2: the chain's guardian approval already consented — write it as
        // the arena's per-student consent so entry passes without re-asking.
        for (const studentId of studentIds) {
          const c = await db.ultimateConsent.findFirst({ where: { schoolId, studentId } });
          if (!c) {
            await db.ultimateConsent.create({ data: { schoolId, studentId, granted: true, grantedById: p.userId } });
          } else if (!c.granted) {
            await db.ultimateConsent.update({ where: { id: c.id }, data: { granted: true, grantedById: p.userId } });
          }
        }
      }
      arena = true;
    }

    // --- notify every candidate + guardians -----------------------------------
    const when = program.examAt.toISOString().slice(0, 16).replace("T", " at ");
    const howTo =
      program.examMode === "ONLINE_CBT" ? "Sit it under CBT Exams in the app on the exam date."
      : program.examMode === "GAMES" ? "Enter it from Games → Ultimate on the exam date."
      : "Attend at the venue below.";
    const modeLabel =
      program.examMode === "ONLINE_CBT" ? "an online CBT mock exam" : program.examMode === "GAMES" ? "the games arena" : "a physical scheduled exam";
    let notified = 0;
    for (const c of candidates) {
      await this.notifyFamily(
        p,
        c.schoolId,
        c.studentId,
        `Scholarship exam scheduled — “${program.title}”`,
        `Category: ${String(program.category).replaceAll("_", " ").toLowerCase()}. The exam holds via ${modeLabel} on ${when} (UTC)${program.examVenue ? ` — ${program.examVenue}` : ""}. ${howTo} Good luck!`,
      );
      notified += 1;
    }
    await this.auditOwn(p, "scholarship.exam.announce", programId, {
      candidates: candidates.length,
      examMode: program.examMode,
      cbtExams,
      arena,
    });
    return { notified, cbtExams, arena };
  }

  /** Harvest exam results back onto the QUALIFIED applications as a score SIGNAL
   *  (Golden Rule #8 — informs the award, isn't the award). ONLINE_CBT reads the
   *  student's submitted CbtSitting score %; GAMES ranks arena finishers by
   *  (fewest guesses → fastest own-start elapsed) into a relative %. Returns how
   *  many candidates now carry a score. */
  /**
   * The published results, as EVERY SCHOOL on the platform reads them.
   *
   * THE SECOND CROSS-TENANT TABLE IN THIS PLATFORM, and it carries no more PII
   * than the first: the Ultimate arena crosses the boundary with handles and
   * school names, never real names, and this crosses it with SCHOOL, POSITION
   * and SCORE. A scholarship result is read by every tenant, and naming a minor
   * in it is a disclosure their family never asked for — the owner's explicit
   * decision, and the right one.
   *
   * PRIVILEGED BY NECESSITY: the whole point is that a school sees results from
   * schools that are not theirs, which no tenant-scoped read can do. What makes
   * that safe is the SHAPE of what is selected, not the scoping — so the select
   * below is the control, and a test asserts it never grows a name.
   *
   * UNPUBLISHED PROGRAMMES ARE INVISIBLE, not empty: `resultsPublishedAt` is
   * the owner's decision that the marking has been reviewed, and an empty table
   * would say the exam produced nothing.
   */
  async publishedResults(limit = PUBLISHED_RESULTS_PROGRAMS): Promise<PublishedScholarshipResultsDto[]> {
    const db = this.client();
    const programs = await db.scholarshipProgram.findMany({
      where: { resultsPublishedAt: { not: null } },
      orderBy: { resultsPublishedAt: "desc" },
      take: limit,
      select: { id: true, title: true, category: true, resultsPublishedAt: true },
    });
    if (programs.length === 0) return [];
    // ONE query for every programme's rows, not one per programme.
    const rows = await db.scholarshipApplication.findMany({
      where: { programId: { in: programs.map((x) => x.id) }, examScorePct: { not: null } },
      orderBy: [{ examScorePct: "desc" }],
      take: limit * PUBLISHED_RESULTS_ROWS,
      // THE CONTROL. No studentId, no name, no application id — a reader of this
      // table can identify a SCHOOL and never a child.
      select: { programId: true, schoolId: true, examScorePct: true, awardPosition: true },
    });
    // And ONE query for the school names.
    const schools = await db.school.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.schoolId))] } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(schools.map((x) => [x.id, x.name]));
    return programs.map((prog) => ({
      programId: prog.id,
      title: prog.title,
      category: String(prog.category),
      publishedAt: prog.resultsPublishedAt!,
      rows: rows
        .filter((r) => r.programId === prog.id)
        // AWARDED POSITIONS FIRST, then by score. A reader looking for "who
        // won" should not have to scan a table sorted only by percentage.
        .sort((a, b) => (a.awardPosition ?? 99) - (b.awardPosition ?? 99) || (b.examScorePct ?? 0) - (a.examScorePct ?? 0))
        .slice(0, PUBLISHED_RESULTS_ROWS)
        .map((r) => ({
          position: r.awardPosition ?? null,
          schoolName: nameOf.get(r.schoolId) ?? "A school",
          scorePct: r.examScorePct ?? 0,
        })),
    }));
  }

  /**
   * PUBLISH the results to every school on the platform.
   *
   * A score is a fact about a child's exam, so nothing outside the operator
   * console sees one until the owner has reviewed the marking and decided.
   * `resultsPublishedAt` is that decision, and it is what the public read keys
   * on — unpublished programmes are invisible rather than empty.
   *
   * Idempotent: publishing twice keeps the FIRST date, because when a result
   * became public is a fact about the programme and moving it would rewrite it.
   */
  async publishResults(p: Principal, programId: string): Promise<{ publishedAt: Date; rows: number }> {
    const db = this.client();
    const program = await db.scholarshipProgram.findFirst({
      where: { id: programId },
      select: { id: true, title: true, resultsPublishedAt: true },
    });
    if (!program) throw new NotFoundException("Program not found");
    const scored = await db.scholarshipApplication.count({
      where: { programId, examScorePct: { not: null } },
    });
    if (scored === 0) {
      // Publishing an empty table says the exam produced nothing, which is a
      // statement about every candidate who sat it.
      throw new BadRequestException(
        "No candidate has a score yet — collect the exam results before publishing them.",
      );
    }
    const publishedAt = program.resultsPublishedAt ?? new Date();
    if (!program.resultsPublishedAt) {
      await db.scholarshipProgram.update({ where: { id: programId }, data: { resultsPublishedAt: publishedAt } });
    }
    await this.auditOwn(p, "scholarship.results.publish", programId, { rows: scored, publishedAt });
    return { publishedAt, rows: scored };
  }

  /** Withdraw a publication. The date is CLEARED, so the table disappears from
   *  every school at once — the only way back once something is public. */
  async unpublishResults(p: Principal, programId: string): Promise<{ ok: true }> {
    const db = this.client();
    const res = await db.scholarshipProgram.updateMany({
      where: { id: programId },
      data: { resultsPublishedAt: null },
    });
    if (res.count === 0) throw new NotFoundException("Program not found");
    await this.auditOwn(p, "scholarship.results.unpublish", programId, {});
    return { ok: true };
  }

  async collectExamResults(p: Principal, programId: string): Promise<{ updated: number }> {
    const db = this.client();
    const program = await db.scholarshipProgram.findFirst({ where: { id: programId } });
    if (!program) throw new NotFoundException("Program not found");
    const candidates = await db.scholarshipApplication.findMany({
      where: { programId, status: "QUALIFIED" },
      select: { id: true, schoolId: true, studentId: true },
    });
    let updated = 0;

    if (program.examMode === "ONLINE_CBT") {
      // THREE QUERIES, not three PER CANDIDATE.
      //
      // This read the exam once per candidate, so every pupil in a school
      // re-fetched that school's single exam row — 300 candidates in one school
      // meant 300 identical lookups. Measured before the change: 637 ms for 300
      // candidates while doing NO work at all, because no exam existed and each
      // one looked for it anyway. With sittings present it was three queries per
      // candidate, and this is an operator pressing a button on a program that
      // spans every school in the platform.
      //
      // `announceExam`, directly above, already groups by school. This did not —
      // the same job, written twice, one of them per-row.
      const exams = (await db.cbtExam.findMany({
        where: { scholarshipProgramId: programId, schoolId: { in: [...new Set(candidates.map((c) => c.schoolId))] } },
        select: { id: true, schoolId: true },
      })) as Array<{ id: string; schoolId: string }>;
      // A SCHOOL NOW HAS ONE EXAM PER PAPER, not one exam. This was a
      // `Map<schoolId, examId>`, which silently kept whichever paper came last
      // and scored every candidate on that one alone.
      const examsOfSchool = new Map<string, string[]>();
      for (const e of exams) examsOfSchool.set(e.schoolId, [...(examsOfSchool.get(e.schoolId) ?? []), e.id]);
      const sittings = exams.length
        ? ((await db.cbtSitting.findMany({
            where: {
              examId: { in: exams.map((e) => e.id) },
              studentId: { in: candidates.map((c) => c.studentId) },
              status: "SUBMITTED",
            },
            select: { examId: true, studentId: true, score: true, total: true },
          })) as Array<{ examId: string; studentId: string; score: number | null; total: number | null }>)
        : [];
      const sittingOf = new Map(sittings.map((s2) => [`${s2.examId}:${s2.studentId}`, s2]));
      const scored: Array<{ id: string; pct: number }> = [];
      for (const c of candidates) {
        const examIds = examsOfSchool.get(c.schoolId) ?? [];
        if (examIds.length === 0) continue;
        // THE AVERAGE ACROSS THE PAPERS THEY SAT, weighted by nothing: each
        // paper is a percentage in its own right and they count equally, which
        // is what a candidate would assume of "Maths and English".
        //
        // ONLY the papers they actually sat. Counting an unsat paper as zero
        // would mark a candidate down for a paper that may not have opened yet,
        // and this runs whenever the operator presses collect — including
        // between two sittings on different days.
        const pcts: number[] = [];
        for (const examId of examIds) {
          const sitting = sittingOf.get(`${examId}:${c.studentId}`);
          if (!sitting || sitting.total == null || sitting.total === 0 || sitting.score == null) continue;
          pcts.push((sitting.score / sitting.total) * 100);
        }
        if (pcts.length === 0) continue;
        const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
        scored.push({ id: c.id, pct: Math.round(mean * 100) / 100 });
      }
      updated = await this.writeScores(db, scored);
    } else if (program.examMode === "GAMES") {
      const comp = await db.ultimateCompetition.findFirst({ where: { scholarshipProgramId: programId }, select: { id: true } });
      if (comp) {
        // Rank finishers: fewest guesses, then fastest own-start elapsed.
        const finishers = await db.ultimateParticipant.findMany({
          where: { competitionId: comp.id, status: "FINISHED" },
          select: { id: true, guessCount: true, elapsedMs: true },
        });
        finishers.sort((a, b) => (a.guessCount - b.guessCount) || ((a.elapsedMs ?? Infinity) - (b.elapsedMs ?? Infinity)));
        // participantId → userId via the tenant-scoped entry link (per school).
        const n = finishers.length;
        // One query for every entry link, and a map for the candidate lookup —
        // this read a link per finisher and then scanned the candidate array for
        // each one, which is a query per row on top of an O(n²) search.
        const links = (await db.ultimateEntryLink.findMany({
          where: { participantId: { in: finishers.map((f) => f.id) } },
          select: { participantId: true, userId: true },
        })) as Array<{ participantId: string; userId: string }>;
        const userOfParticipant = new Map(links.map((l) => [l.participantId, l.userId]));
        const candOfStudent = new Map(candidates.map((c) => [c.studentId, c]));
        const scored: Array<{ id: string; pct: number }> = [];
        for (let rank = 0; rank < n; rank++) {
          const userId = userOfParticipant.get(finishers[rank].id);
          const cand = userId ? candOfStudent.get(userId) : undefined;
          if (!cand) continue;
          // Relative standing %: 1st = 100, last = ~ (1/n)·100.
          scored.push({ id: cand.id, pct: Math.round(((n - rank) / n) * 10000) / 100 });
        }
        updated = await this.writeScores(db, scored);
      }
    } else {
      throw new BadRequestException("Automatic result collection applies to online CBT and games exams only");
    }
    await this.auditOwn(p, "scholarship.exam.collect", programId, { examMode: program.examMode, updated });
    return { updated };
  }

  /**
   * Record marks for a PHYSICAL exam, by hand.
   *
   * A physical exam could be chosen, and its candidates were told the venue and
   * the time — and there was NO WAY to enter what they scored. `writeScores`
   * was private with two callers, CBT and the arena, and no route accepted a
   * mark. So a paper exam ran to the end of its process and dead-ended: nobody
   * could be scored, so nobody could be ranked, so no school could win its
   * prize on merit. The mode was offered and could not be finished.
   *
   * PHYSICAL ONLY, and that is the load-bearing part. A CBT programme's scores
   * are derived from the sittings, so a hand-typed mark there is either
   * overwritten by the next `collect-results` or silently overwrites a real
   * script — two writers of one column disagreeing, which is the defect this
   * codebase keeps finding. An operator who genuinely wants to override a CBT
   * mark is asking for a different feature.
   */
  async recordPhysicalScores(
    p: Principal,
    programId: string,
    marks: Array<{ applicationId: string; scorePct: number }>,
  ): Promise<{ updated: number }> {
    const db = this.client();
    const program = await db.scholarshipProgram.findFirst({
      where: { id: programId },
      select: { id: true, examMode: true },
    });
    if (!program) throw new NotFoundException("Program not found");
    if (program.examMode !== "PHYSICAL") {
      throw new BadRequestException(
        "Marks are entered by hand only for a physical exam. An online CBT or games exam is scored from what the candidates actually sat — use Collect results.",
      );
    }
    // EVERY id must be a QUALIFIED candidate OF THIS PROGRAMME. Without this an
    // operator marking programme A could write onto programme B's candidate,
    // and RLS cannot help — this is the privileged cross-tenant client.
    const eligible = (await db.scholarshipApplication.findMany({
      where: { programId, status: "QUALIFIED", id: { in: marks.map((m) => m.applicationId) } },
      select: { id: true },
    })) as Array<{ id: string }>;
    const known = new Set(eligible.map((e) => e.id));
    const strangers = marks.filter((m) => !known.has(m.applicationId));
    if (strangers.length > 0) {
      // THE WHOLE LIST IS REFUSED, never the recognised part: a mark sheet
      // silently one name short is the silent-partial-success shape, and the
      // operator would believe every candidate in front of them was recorded.
      throw new BadRequestException(
        `${strangers.length} of ${marks.length} entries are not qualified candidates of this programme, so nothing was recorded.`,
      );
    }
    const updated = await this.writeScores(
      db,
      marks.map((m) => ({ id: m.applicationId, pct: Math.round(m.scorePct * 100) / 100 })),
    );
    await this.auditOwn(p, "scholarship.exam.score", programId, { examMode: "PHYSICAL", updated });
    return { updated };
  }

  /**
   * Write every candidate's exam percentage in ONE statement.
   *
   * Prisma has no bulk update with a different value per row, and a loop of
   * `update` calls is a round trip each — the shape this whole method was. A
   * single UPDATE ... FROM (VALUES ...) does the same work in one, and the
   * numbers are computed here rather than in SQL so the arithmetic stays in one
   * place and testable.
   *
   * Chunked, because a statement with tens of thousands of bound parameters is
   * its own problem: Postgres caps them at 65,535 and each row here binds two.
   */
  private async writeScores(db: PrismaClient, scored: Array<{ id: string; pct: number }>): Promise<number> {
    if (scored.length === 0) return 0;
    const CHUNK = 1000;
    let written = 0;
    for (let i = 0; i < scored.length; i += CHUNK) {
      const batch = scored.slice(i, i + CHUNK);
      const values = Prisma.join(
        batch.map((s) => Prisma.sql`(${s.id}::uuid, ${s.pct}::double precision)`),
      );
      written += await db.$executeRaw`
        UPDATE "scholarship_application" AS a
           SET "examScorePct" = v.pct, "updatedAt" = now()
          FROM (VALUES ${values}) AS v(id, pct)
         WHERE a.id = v.id`;
    }
    return written;
  }

  /** Notify the student AND their guardians inside THEIR OWN school's tenant
   *  (the operator writes the notification rows under that school's GUC — RLS
   *  intact; recipients read them via their normal self-scoped inbox). */
  /**
   * Tell the school's leadership something about their own subscription.
   *
   * The prize is theirs, not the family's, so it goes to whoever runs the
   * school rather than through `notifyFamily`. Best-effort: the grant is the
   * durable fact and a failed notice must not undo it.
   */
  private async notifySchool(schoolId: string, title: string, body: string, actorId: string): Promise<void> {
    const ctx = { schoolId, userId: actorId };
    try {
      const leaders = await this.db.runAsTenant(ctx, (tx) =>
        tx.user.findMany({
          where: { status: "ACTIVE", roles: { some: { role: { name: { in: [...SCHOOL_PRIZE_RECIPIENTS] } } } } },
          select: { id: true },
        }),
      );
      for (const l of leaders as Array<{ id: string }>) {
        await this.notifications
          .enqueue(ctx, { recipientId: l.id, type: "SCHOLARSHIP", title, body })
          .catch(() => undefined);
      }
    } catch (err) {
      this.logger.warn(`school prize notify failed (non-fatal): ${String(err)}`);
    }
  }

  private async notifyFamily(p: Principal, schoolId: string, studentId: string, title: string, body: string): Promise<void> {
    const ctx = { schoolId, userId: p.userId };
    try {
      await this.notifications.enqueue(ctx, { recipientId: studentId, type: "SCHOLARSHIP", title, body });
      const guardians = await this.db.runAsTenant(ctx, (tx) =>
        tx.parentChild.findMany({ where: { studentId }, select: { parentId: true } }),
      );
      for (const g of guardians as Array<{ parentId: string }>) {
        await this.notifications.enqueue(ctx, { recipientId: g.parentId, type: "SCHOLARSHIP", title, body }).catch(() => undefined);
      }
    } catch (err) {
      this.logger.warn(`scholarship family notify failed (non-fatal): ${String(err)}`);
    }
  }

  /** Post a SCHOLARSHIP payment against the student's most recent open invoice
   *  (capped at the outstanding balance so it never over-credits). Updates the
   *  invoice status. Returns null if there's no open invoice to credit. */
  /**
   * Post the award as a fees credit — or say why it could not.
   *
   * A NULL return used to mean "no open invoice", and the caller treated it the
   * same as success: it told the family "the award has been credited against
   * the student's school fees" either way. It now reports which of the three
   * things happened, so the family is told the truth and the operator learns
   * about the one case that needs a person.
   */
  /**
   * The winner's SCHOOL gets free ENTERPRISE for a period.
   *
   * A TIME-BOXED UPLIFT beside the purchased plan, never written over it.
   * `plan` is what the school BOUGHT and what renewal is priced from; setting
   * it to ENTERPRISE would bill a STANDARD school at ENTERPRISE seats and leave
   * them there for ever. `effectivePlan` takes the better of paid-vs-granted
   * while `grantedUntil` is in the future, so this expires by DATE — nothing to
   * sweep, nothing to repair, and paying or lapsing meanwhile still behaves
   * exactly as it did.
   *
   * EXTENDS RATHER THAN REPLACES. A school winning twice keeps both prizes: the
   * new window runs from whichever is later, its own start or the grant it
   * already holds. Replacing would silently shorten the first prize.
   *
   * BEST-EFFORT, like the fees credit beside it: a prize is a reward, and
   * failing to grant it must not roll back an award the platform has decided
   * and told the family about. It logs at ERROR so somebody can put it right.
   */
  private async grantSchoolPrize(
    db: PrismaClient,
    schoolId: string,
    position: number,
    programTitle: string,
    actorId: string,
  ): Promise<void> {
    const months = SCHOLARSHIP_SCHOOL_PRIZE_MONTHS[position as 1 | 2 | 3];
    if (!months) return;
    try {
      const sub = await db.schoolSubscription.findFirst({
        where: { schoolId },
        select: { id: true, grantedUntil: true },
      });
      if (!sub) {
        this.logger.error(`school prize for ${schoolId}: no subscription row, nothing granted`);
        return;
      }
      const now = new Date();
      const from = sub.grantedUntil && sub.grantedUntil > now ? sub.grantedUntil : now;
      const until = new Date(from);
      until.setMonth(until.getMonth() + months);
      await db.schoolSubscription.update({
        where: { id: sub.id },
        data: {
          grantedPlan: SCHOLARSHIP_SCHOOL_PRIZE_PLAN,
          grantedUntil: until,
          grantedReason: `${ordinalPosition(position)} place in “${programTitle}” — ${months} months of ${SCHOLARSHIP_SCHOOL_PRIZE_PLAN}`,
          // A fresh window deserves a fresh warning.
          grantExpiryNoticeAt: null,
        },
      });
      this.modules.invalidate(schoolId);
      await this.notifySchool(
        schoolId,
        `Your school has been awarded ${months} months of ${SCHOLARSHIP_SCHOOL_PRIZE_PLAN}`,
        `A pupil of yours took ${ordinalPosition(position)} place in “${programTitle}”. Every ${SCHOLARSHIP_SCHOOL_PRIZE_PLAN} module is open to your school until ${until.toISOString().slice(0, 10)}, at no charge. Your own plan and what you pay for it are unchanged.`,
        actorId,
      );
    } catch (e) {
      // Never unwind an award over the prize: the pupil's money has already
      // moved and the family has already been told.
      this.logger.error(`school prize for ${schoolId} failed: ${(e as Error).message}`);
    }
  }

  /**
   * Take the SCHOOL's half of an award back.
   *
   * An award is TWO awards — a fees credit to the pupil and a free window of
   * ENTERPRISE to their school — and only one of them could be reversed. So a
   * mistaken or fraudulent award was taken back from the family while the
   * school kept up to nine months of a paid tier, on no screen, with no way
   * back, and the operator was told the award had been reversed.
   *
   * SUBTRACT THE MONTHS, never clear the window. `grantSchoolPrize` EXTENDS
   * rather than replaces — a school winning twice keeps both — so nulling the
   * columns would destroy a second, legitimate prize. Extending added N months
   * and this removes N, which composes exactly however many prizes are stacked.
   * If that lands in the past the grant is over and the columns are cleared.
   */
  private async revokeSchoolPrize(
    db: PrismaClient,
    schoolId: string,
    position: number,
    programTitle: string,
    actorId: string,
  ): Promise<void> {
    const months = SCHOLARSHIP_SCHOOL_PRIZE_MONTHS[position as 1 | 2 | 3];
    if (!months) return;
    try {
      const sub = await db.schoolSubscription.findFirst({
        where: { schoolId },
        select: { id: true, grantedUntil: true },
      });
      if (!sub?.grantedUntil) return;
      const until = new Date(sub.grantedUntil);
      until.setMonth(until.getMonth() - months);
      const now = new Date();
      const over = until <= now;
      await db.schoolSubscription.update({
        where: { id: sub.id },
        data: over
          ? { grantedPlan: null, grantedUntil: null, grantedReason: null, grantExpiryNoticeAt: null }
          : // The window shrinks and the REASON stays: what remains was won by
            // the other award, and blanking it would leave a school with an
            // unexplained tier — the contradiction the /billing block exists to
            // remove.
            { grantedUntil: until, grantExpiryNoticeAt: null },
      });
      this.modules.invalidate(schoolId);
      await this.notifySchool(
        schoolId,
        over
          ? `Your school's free ${SCHOLARSHIP_SCHOOL_PRIZE_PLAN} access has ended`
          : `Your school's free ${SCHOLARSHIP_SCHOOL_PRIZE_PLAN} access has been shortened`,
        over
          ? `The award for “${programTitle}” has been taken back, so the ${months} months of ${SCHOLARSHIP_SCHOOL_PRIZE_PLAN} that came with it have ended. Your own plan and what you pay for it are unchanged.`
          : `The award for “${programTitle}” has been taken back, so ${months} months have come off the free ${SCHOLARSHIP_SCHOOL_PRIZE_PLAN} access. It now runs until ${until.toISOString().slice(0, 10)}. Your own plan and what you pay for it are unchanged.`,
        actorId,
      );
    } catch (e) {
      // Best-effort, exactly like the grant: the pupil's money has already been
      // returned and the application is already back to QUALIFIED, and losing
      // that to a notification failure would be worse.
      this.logger.error(`school prize reversal for ${schoolId} failed: ${(e as Error).message}`);
    }
  }

  private async disburseFeesCredit(
    db: PrismaClient,
    schoolId: string,
    studentId: string,
    awardMinor: number,
    applicationId: string,
    actorId: string,
  ): Promise<DisbursementOutcome> {
    const invoice = await db.invoice.findFirst({
      where: { schoolId, studentId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
      include: { payments: true },
      orderBy: { createdAt: "desc" },
    });
    // NO OPEN INVOICE IS NOT A DEAD END — it is the ordinary case.
    //
    // An award is frequently decided before the term's fees are raised, and
    // this used to give up: the award stood, nothing posted, and NOTHING EVER
    // RETRIED. Measured on the demo tenant, four AWARDED applications totalling
    // NGN 800,000 had credited nobody.
    //
    // Every other path that moves money against a pupil already handles it —
    // the library, hostel and transport runs CREATE an invoice, and a
    // dedicated-account transfer posts to the CREDIT LEDGER and tells finance
    // to apply it from the next invoice's page. Raising an invoice would be
    // wrong here (a scholarship is not a charge), so this takes the credit
    // ledger, which is the mechanism built for exactly "money arrived and there
    // is no invoice yet".
    if (!invoice) return this.holdAsCredit(db, schoolId, studentId, awardMinor, applicationId, actorId);
    // THE CURRENCY MUST MATCH BEFORE ANYTHING POSTS.
    //
    // `awardMinor` is a platform figure in kobo; `invoice.currency` is the
    // school's and can be any code in the catalogue. Posting 5,000,000 kobo
    // (₦50,000) against a GBP invoice credits £50,000, and against a franc
    // invoice — which has no minor unit at all — 5,000,000 francs. In every
    // case the family's fees are cleared and the platform's books record an
    // award a hundred or a thousand times smaller.
    //
    // This is the guard `InvoiceSettlementService.applyOnlinePayment` already
    // makes for every gateway, and the reason it takes a REQUIRED currency:
    // the comparison happens BEFORE the write, because a refusal leaves the
    // invoice untouched and is recoverable, while a posting is not — nothing
    // in the system revisits a settled invoice.
    if (invoice.currency !== AWARD_CURRENCY) {
      return { ok: false, reason: "currency_mismatch", invoiceCurrency: invoice.currency };
    }
    // IDEMPOTENT ON THE APPLICATION, because the claim above cannot help across
    // a crash. If the process dies after this payment is written and before the
    // application records it, the row still reads QUALIFIED and the next award
    // credits the family a SECOND time — no concurrency required. Reproduced
    // against the database: two POSTED payments, the same reference, one award.
    //
    // The reference already identified the award uniquely; nothing looked. This
    // is the check `billFine` makes a few files away for exactly this reason.
    // Is there an UNREVERSED credit for this award? Not merely "a credit".
    //
    // A revoked award leaves the original payment POSTED and adds a REFUND
    // beside it — there is no REVERSED payment status, and a financial row is
    // not rewritten. So a check for "a POSTED credit with this reference" says
    // yes to an award that has already been taken back, and a re-award then
    // posts nothing: the application reads AWARDED while the ledger nets to
    // zero. Caught by running award -> revoke -> re-award against the database
    // and reading the ledger, not by any test — the test I had written guarded a
    // REVERSED status that does not exist.
    const credited = invoice.payments.filter(
      (pay) => pay.reference === `SCHOLARSHIP:${applicationId}` && pay.status === "POSTED",
    );
    const reversed = invoice.payments.filter(
      (pay) => pay.reference === `SCHOLARSHIP-REVERSAL:${applicationId}` && pay.status === "POSTED",
    );
    const outstanding = credited[reversed.length];
    if (outstanding) return { ok: true, kind: "INVOICE", paymentId: outstanding.id, amountMinor: outstanding.amountMinor };
    const paid = invoice.payments
      .filter((pay) => pay.status === "POSTED")
      .reduce((s, pay) => s + (pay.kind === "REFUND" ? -pay.amountMinor : pay.amountMinor), 0);
    const balance = Math.max(0, invoice.totalMinor - paid);
    if (balance <= 0) return { ok: false, reason: "nothing_outstanding" };
    const credit = Math.min(awardMinor, balance);
    const payment = await db.payment.create({
      data: {
        schoolId,
        invoiceId: invoice.id,
        amountMinor: credit,
        method: "OTHER",
        kind: "SCHOLARSHIP",
        status: "POSTED",
        reference: `SCHOLARSHIP:${applicationId}`,
        note: "Platform-sponsored scholarship credit",
        recordedById: actorId,
      },
    });
    const newPaid = paid + credit;
    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: newPaid >= invoice.totalMinor ? "PAID" : "PARTIALLY_PAID" },
    });
    return { ok: true, kind: "INVOICE", paymentId: payment.id, amountMinor: credit };
  }

  /**
   * Hold the award on the pupil's CREDIT LEDGER, for the case where there is no
   * open invoice to post it against.
   *
   * The balance sums every entry for a pupil grouped by currency, so this is
   * spendable the moment the school raises a bill — through the ordinary
   * apply-credit path, with no new mechanism and no second posting route.
   *
   * IDEMPOTENT ON THE APPLICATION, exactly like the invoice arm: the award is
   * claimed before this runs, but a crash between the claim and the write would
   * otherwise credit a family twice on the retry. The reference already
   * identifies the award uniquely.
   *
   * ONLY IN THE AWARD'S OWN CURRENCY. A credit is spendable only against an
   * invoice in its own currency, so writing an NGN credit into a school that
   * bills in cedis creates money the family can never use and a ledger line
   * nobody can explain — worse than refusing, and the same reasoning the
   * invoice arm's `currency_mismatch` already applies. There is no FX rate in
   * this platform and inventing one to move an award would be worse than the
   * gap.
   */
  private async holdAsCredit(
    db: PrismaClient,
    schoolId: string,
    studentId: string,
    awardMinor: number,
    applicationId: string,
    actorId: string,
  ): Promise<DisbursementOutcome> {
    const school = await db.school.findFirst({ where: { id: schoolId }, select: { country: true, currency: true } });
    const schoolCurrency = resolveRegion(school ?? {}).currency;
    if (schoolCurrency !== AWARD_CURRENCY) {
      return { ok: false, reason: "school_bills_another_currency", schoolCurrency };
    }
    const reference = `SCHOLARSHIP:${applicationId}`;
    const existing = await db.studentCreditEntry.findFirst({ where: { schoolId, studentId, reference } });
    if (existing) return { ok: true, kind: "CREDIT", creditEntryId: existing.id, amountMinor: existing.deltaMinor };
    const entry = await db.studentCreditEntry.create({
      data: {
        schoolId,
        studentId,
        deltaMinor: awardMinor,
        // STAMPED, never left null: null means "the school's own currency", and
        // an award is denominated by the PLATFORM. They agree today because the
        // guard above requires it, and saying so keeps that true if it changes.
        currency: AWARD_CURRENCY,
        reason: "SCHOLARSHIP",
        reference,
        note: "Platform-sponsored scholarship — no open invoice when awarded",
        createdById: actorId,
      },
    });
    return { ok: true, kind: "CREDIT", creditEntryId: entry.id, amountMinor: entry.deltaMinor };
  }

  private async listApplicationById(db: PrismaClient, id: string): Promise<ScholarshipApplicationDto[]> {
    const rows = await db.scholarshipApplication.findMany({ where: { id } });
    if (rows.length === 0) return [];
    const r = rows[0];
    const [program, student, applicant, school] = await Promise.all([
      db.scholarshipProgram.findFirst({
        where: { id: r.programId },
        select: { title: true, awardMinor: true, examMode: true, examAt: true },
      }),
      db.user.findFirst({ where: { id: r.studentId }, select: { name: true } }),
      db.user.findFirst({ where: { id: r.applicantId }, select: { name: true } }),
      db.school.findFirst({ where: { id: r.schoolId }, select: { name: true } }),
    ]);
    return [{
      id: r.id, programId: r.programId, programTitle: program?.title ?? "Scholarship", awardMinorOffered: program?.awardMinor ?? 0,
      // EITHER LINK counts as disbursed. Reading only the payment id was true
      // while an award could reach nowhere else; an award held on the credit
      // ledger has moved real money and would have read "not yet credited".
      disbursed:
        r.status === "AWARDED" ? Boolean(r.disbursementPaymentId || r.disbursementCreditEntryId) : null,
      disbursementKind: r.disbursementPaymentId ? "INVOICE" : r.disbursementCreditEntryId ? "CREDIT" : null,
      schoolId: r.schoolId, schoolName: school?.name ?? null, studentId: r.studentId, studentName: student?.name ?? "Student",
      applicantId: r.applicantId, applicantName: applicant?.name ?? "Applicant", applicantRole: r.applicantRole,
      answers: r.answers ?? null, signals: (r.signals as ScholarshipApplicationDto["signals"]) ?? null, status: r.status,
      consentById: r.consentById, consentAt: r.consentAt,
      supervisorById: r.supervisorById,
      supervisorStage: scholarshipSupervisorStage(r), supervisorAt: r.supervisorAt, supervisorNote: r.supervisorNote,
      parentNote: r.parentNote, principalById: r.principalById, principalAt: r.principalAt, principalNote: r.principalNote,
      rejectedStage: r.rejectedStage,
      examMode: program?.examMode ?? null, examAt: program?.examAt ?? null,
      examScorePct: r.examScorePct, awardPosition: r.awardPosition,
      awardMinor: r.awardMinor, reviewNote: r.reviewNote,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    }];
  }

  /**
   * The exam paper as written, for the operator who wrote it.
   *
   * Questions could only ever be APPENDED from the console — no read, no edit,
   * no remove — so a typo in the text, or a wrong `answerIndex`, was PERMANENT.
   * On a scholarship exam the answer key decides who is awarded money, and a
   * wrong key marks correct answers wrong for every candidate.
   *
   * `scholarship.admin` only. The count alone reaches everybody else, including
   * the candidate portal.
   */
  async listExamQuestions(programId: string): Promise<ScholarshipExamQuestionDto[]> {
    const db = this.client();
    const program = await db.scholarshipProgram.findFirst({
      where: { id: programId },
      select: { examQuestions: true },
    });
    if (!program) throw new NotFoundException("Program not found");
    const raw = Array.isArray(program.examQuestions)
      ? (program.examQuestions as unknown as Array<{ text: string; options: string[]; answerIndex: number; subject?: string | null }>)
      : [];
    return raw.map((q, index) => ({
      index,
      subject: q.subject ?? null,
      text: q.text,
      options: q.options,
      answerIndex: q.answerIndex,
    }));
  }

  private programDto(r: {
    id: string; title: string; description: string | null; budgetMinor: bigint | number; awardMinor: number;
    award2Minor: number | null; award3Minor: number | null;
    awardKind: string; selectionBasis: string; eligibility: unknown; opensAt: Date; closesAt: Date; status: string;
    category: string; examMode: string | null; examAt: Date | null; examVenue: string | null;
    examDurationMin: number; examQuestions: unknown; examSchedule: unknown; resultsPublishedAt: Date | null; createdAt: Date;
  }, committedMinor = 0): ScholarshipProgramDto {
    return {
      id: r.id, title: r.title, description: r.description, budgetMinor: toMinor(r.budgetMinor),
      committedMinor, awardMinor: r.awardMinor,
      award2Minor: r.award2Minor, award3Minor: r.award3Minor,
      awardKind: r.awardKind, selectionBasis: r.selectionBasis, eligibility: r.eligibility ?? null,
      opensAt: r.opensAt, closesAt: r.closesAt, status: r.status,
      category: r.category, examMode: r.examMode, examAt: r.examAt, examVenue: r.examVenue,
      examDurationMin: r.examDurationMin,
      examQuestionCount: Array.isArray(r.examQuestions) ? r.examQuestions.length : 0,
      resultsPublishedAt: r.resultsPublishedAt ?? null,
      examSchedule: (r.examSchedule ?? null) as Record<string, { examAt: string; durationMin?: number }> | null,
      createdAt: r.createdAt,
    };
  }

  /** Audit in the OPERATOR's own tenant (best-effort — the privileged write is
   *  the source of truth and is also captured by the request log). */
  private async auditOwn(p: Principal, action: string, entityId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.db
      .runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
        this.audit.record({ actorId: p.userId, action, entity: "scholarship", entityId, schoolId: p.schoolId, metadata }, tx),
      )
      .catch((err) => this.logger.warn(`audit '${action}' failed (non-fatal): ${String(err)}`));
  }
}
