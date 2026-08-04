// =============================================================================
// ComplianceService — the screen a school shows its data-protection officer
// =============================================================================
// The platform was built to NDPR and said so throughout. A school in the EU or UK
// falls under GDPR, which adds obligations the product had nowhere to record:
//
//   Art. 33  notify the supervisory authority within 72 HOURS of becoming aware
//            of a personal-data breach;
//   Art. 34  tell the affected people themselves when the risk to them is high;
//   Art. 37  designate a DPO — which a school processing children's data at scale
//            is squarely within.
//
// THE CLOCK RUNS FROM AWARENESS. `discoveredAt` is when the school became aware,
// not when the breach happened and not when somebody got round to typing it in.
// Those are three different moments and only one of them starts the 72 hours, so
// it is captured explicitly and never edited afterwards.
//
// Everything here is AGGREGATE. A DPO asks how many, how long, and whether you
// notified in time — never who. No pupil is named on this surface.
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  breachDeadlineBasis,
  breachTarget,
  complianceProfile,
  BREACH_RISK_LEVELS,
  type BreachIncidentDto,
  type BreachRiskLevel,
  type BreachStatus,
  type CompliancePostureDto,
} from "@sms/types";
import { SchoolRegionService } from "../foundation/school-region.service";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const HOUR_MS = 3_600_000;

type Row = {
  id: string;
  title: string;
  description: string;
  discoveredAt: Date;
  status: string;
  riskLevel: string;
  affectedCount: number;
  dataCategories: string | null;
  notifiedAuthorityAt: Date | null;
  notifiedSubjectsAt: Date | null;
  noNotificationReason: string | null;
  reportedById: string;
  closedAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class ComplianceService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly region: SchoolRegionService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /**
   * The 72-hour clock, computed here rather than stored.
   *
   * Stored, it would be wrong the moment anyone corrected a discovery time, and it
   * would let the record and the screen disagree about whether a school is late —
   * which is the single fact this whole register exists to establish.
   */
  private clockFor(r: Row, now: Date, regime?: string | null) {
    // The deadline comes from the REGIME, not from a constant. 72 hours is the
    // law under GDPR Art. 33, Nigeria's NDPA and Kenya's DPA — but POPIA sets no
    // fixed period, and for a country whose law is not modelled here a
    // statutory-looking countdown invents a deadline. `statutory` carries that
    // distinction to the screen so the same number can be shown honestly as
    // either "your deadline" or "good practice".
    const target = breachTarget(regime);
    const notifyDueAt = new Date(r.discoveredAt.getTime() + target.hours * HOUR_MS);
    const hoursRemaining = Math.round((notifyDueAt.getTime() - now.getTime()) / HOUR_MS);
    // Not notifying can be lawful — Art. 33(1) excuses it where the breach is
    // "unlikely to result in a risk". But it must be a RECORDED decision, so an
    // incident with neither a notification nor a stated reason is overdue.
    const overdue =
      !r.notifiedAuthorityAt && !r.noNotificationReason && now.getTime() > notifyDueAt.getTime() && r.status !== "CLOSED";
    // Art. 34: high risk means the people themselves must be told, not just the
    // regulator. Telling the regulator and stopping there is a common failing.
    const subjectsUnnotified = r.riskLevel === "HIGH" && !!r.notifiedAuthorityAt && !r.notifiedSubjectsAt;
    return { notifyDueAt, hoursRemaining, overdue, subjectsUnnotified, deadlineIsStatutory: target.statutory };
  }

  private toDto(r: Row, reporterName: string, now: Date, regime?: string | null): BreachIncidentDto {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      discoveredAt: r.discoveredAt,
      status: r.status as BreachStatus,
      riskLevel: r.riskLevel as BreachRiskLevel,
      affectedCount: r.affectedCount,
      dataCategories: r.dataCategories,
      notifiedAuthorityAt: r.notifiedAuthorityAt,
      notifiedSubjectsAt: r.notifiedSubjectsAt,
      noNotificationReason: r.noNotificationReason,
      reportedByName: reporterName,
      closedAt: r.closedAt,
      createdAt: r.createdAt,
      ...this.clockFor(r, now, regime),
    };
  }

  /** Record a breach. The clock starts at `discoveredAt`, not now. */
  async reportBreach(
    p: Principal,
    input: {
      title: string;
      description: string;
      discoveredAt: string;
      riskLevel?: string;
      affectedCount?: number;
      dataCategories?: string;
    },
  ): Promise<BreachIncidentDto> {
    const discoveredAt = new Date(input.discoveredAt);
    if (Number.isNaN(discoveredAt.getTime())) throw new BadRequestException("discoveredAt must be a valid date");
    // A future discovery date would put the deadline in the future indefinitely,
    // which is the one way to make this register lie in the school's favour.
    if (discoveredAt.getTime() > Date.now() + HOUR_MS) {
      throw new BadRequestException("discoveredAt cannot be in the future — it is when the school became aware");
    }
    const riskLevel = (input.riskLevel ?? "HIGH").toUpperCase();
    if (!(BREACH_RISK_LEVELS as readonly string[]).includes(riskLevel)) {
      throw new BadRequestException(`riskLevel must be one of ${BREACH_RISK_LEVELS.join(", ")}`);
    }

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = (await tx.dataBreachIncident.create({
        data: {
          schoolId: p.schoolId,
          title: input.title.trim(),
          description: input.description.trim(),
          discoveredAt,
          // HIGH by default, deliberately: assuming low risk is the assumption
          // that loses people their notification.
          riskLevel,
          affectedCount: Math.max(0, Math.round(input.affectedCount ?? 0)),
          dataCategories: input.dataCategories?.trim() || null,
          reportedById: p.userId,
        },
      })) as Row;
      await this.audit.record(
        {
          actorId: p.userId,
          action: "privacy.breach.report",
          entity: "data_breach_incident",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { title: row.title, riskLevel, discoveredAt: discoveredAt.toISOString(), affected: row.affectedCount },
        },
        tx,
      );
      const me = await tx.user.findFirst({ where: { id: p.userId }, select: { name: true } });
      return this.toDto(row, me?.name ?? "(unknown)", new Date(), (await this.region.forSchool(p.schoolId)).compliance);
    });
  }

  /** Record what was done: notified the authority, told the people, or decided
   *  notification was not required — with the reason, which is the part an
   *  authority actually reviews. */
  async updateBreach(
    p: Principal,
    id: string,
    input: {
      status?: string;
      riskLevel?: string;
      notifiedAuthorityAt?: string | null;
      notifiedSubjectsAt?: string | null;
      noNotificationReason?: string | null;
      affectedCount?: number;
    },
  ): Promise<BreachIncidentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = (await tx.dataBreachIncident.findFirst({ where: { id } })) as Row | null;
      if (!existing) throw new NotFoundException("Incident not found");

      const status = input.status?.toUpperCase();
      const riskLevel = input.riskLevel?.toUpperCase();
      if (riskLevel && !(BREACH_RISK_LEVELS as readonly string[]).includes(riskLevel)) {
        throw new BadRequestException(`riskLevel must be one of ${BREACH_RISK_LEVELS.join(", ")}`);
      }
      // Closing a HIGH-risk incident without either telling the people or writing
      // down why not is the exact gap an authority looks for.
      const willBeHigh = (riskLevel ?? existing.riskLevel) === "HIGH";
      const notifiedSubjects = input.notifiedSubjectsAt ?? existing.notifiedSubjectsAt;
      const reason = input.noNotificationReason ?? existing.noNotificationReason;
      if (status === "CLOSED" && willBeHigh && !notifiedSubjects && !reason) {
        throw new BadRequestException(
          "A high-risk breach cannot be closed until the affected people have been told, or a reason for not telling them is recorded (Art. 34).",
        );
      }

      const row = (await tx.dataBreachIncident.update({
        where: { id },
        data: {
          ...(status ? { status } : {}),
          ...(riskLevel ? { riskLevel } : {}),
          // `discoveredAt` is deliberately NOT updatable: it is when the clock
          // started, and a register whose start time moves proves nothing.
          ...(input.notifiedAuthorityAt !== undefined
            ? { notifiedAuthorityAt: input.notifiedAuthorityAt ? new Date(input.notifiedAuthorityAt) : null }
            : {}),
          ...(input.notifiedSubjectsAt !== undefined
            ? { notifiedSubjectsAt: input.notifiedSubjectsAt ? new Date(input.notifiedSubjectsAt) : null }
            : {}),
          ...(input.noNotificationReason !== undefined
            ? { noNotificationReason: input.noNotificationReason || null }
            : {}),
          ...(input.affectedCount !== undefined ? { affectedCount: Math.max(0, Math.round(input.affectedCount)) } : {}),
          ...(status === "CLOSED" ? { closedAt: new Date(), closedById: p.userId } : {}),
        },
      })) as Row;

      await this.audit.record(
        {
          actorId: p.userId,
          action: "privacy.breach.update",
          entity: "data_breach_incident",
          entityId: id,
          schoolId: p.schoolId,
          metadata: { status: row.status, riskLevel: row.riskLevel },
        },
        tx,
      );
      const reporter = await tx.user.findFirst({ where: { id: row.reportedById }, select: { name: true } });
      return this.toDto(row, reporter?.name ?? "(unknown)", new Date(), (await this.region.forSchool(p.schoolId)).compliance);
    });
  }

  /** The register, worst first: overdue, then open, then the rest. */
  async listBreaches(p: Principal): Promise<BreachIncidentDto[]> {
    // One region read for the whole list — the deadline is a property of the
    // school, not of each incident.
    const regime = (await this.region.forSchool(p.schoolId)).compliance;
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = (await tx.dataBreachIncident.findMany({ orderBy: { discoveredAt: "desc" }, take: 200 })) as Row[];
      if (rows.length === 0) return [];
      const ids = [...new Set(rows.map((r) => r.reportedById))];
      const users = (await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) as Array<{
        id: string;
        name: string;
      }>;
      const by = new Map(users.map((u) => [u.id, u.name]));
      const now = new Date();
      return rows
        .map((r) => this.toDto(r, by.get(r.reportedById) ?? "(unknown)", now, regime))
        .sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.discoveredAt.getTime() - a.discoveredAt.getTime());
    });
  }

  /**
   * The compliance posture — one screen a school can put in front of a DPO.
   *
   * Deliberately says what is MISSING as loudly as what is present: a page that
   * only lists what you have done reads as a clean bill of health.
   */
  async posture(p: Principal): Promise<CompliancePostureDto> {
    const region = await this.region.forSchool(p.schoolId);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * HOUR_MS);

    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const school = (await tx.school.findFirst({
        where: { id: p.schoolId },
        select: { dpoName: true, dpoEmail: true, integrityRetentionDays: true },
      })) as { dpoName: string | null; dpoEmail: string | null; integrityRetentionDays: number } | null;

      const rows = (await tx.dataBreachIncident.findMany({ take: 500 })) as Row[];
      const now = new Date();
      const clocked = rows.map((r) => ({ r, c: this.clockFor(r, now, region.compliance) }));

      const [erasurePending, consentRecorded, studentRoles] = await Promise.all([
        tx.erasureRequest.count({ where: { status: "PENDING" } }),
        // Guardian consent for behavioural telemetry on minors — the platform's
        // existing lawful-basis record.
        tx.integrityConsent.count(),
        this.countStudents(tx),
      ]);

      // The officer requirement is regime DATA now. It used to be true only for
      // GDPR and NDPR, so a school in Nairobi or Johannesburg was told
      // affirmatively that no officer was required — Kenya's DPA requires a Data
      // Protection Officer and POPIA makes an Information Officer mandatory.
      // Saying nothing would have been safer than saying that.
      const profile = complianceProfile(region.compliance);
      const dpoRequired = profile.officerRequired;

      return {
        regime: profile.key,
        regimeLabel: profile.label,
        // FALSE means "we do not model your country's law", never "you have no
        // obligations". Every consumer must present it that way.
        regimeModelled: profile.modelled,
        regimeNote: profile.note,
        officerTitle: profile.officerTitle,
        breachAuthority: profile.authority,
        breachDeadlineIsStatutory: profile.breachNotify.kind === "hours",
        // WHY it is not statutory, so the screen can distinguish "the law names
        // no period" from "we have not established the period".
        breachDeadlineBasis: breachDeadlineBasis(region.compliance),
        country: region.country,
        dpoName: school?.dpoName ?? null,
        dpoEmail: school?.dpoEmail ?? null,
        dpoRequired,
        dpoMissing: dpoRequired && !school?.dpoEmail,
        breaches: {
          open: rows.filter((r) => r.status !== "CLOSED").length,
          overdue: clocked.filter((x) => x.c.overdue).length,
          subjectsUnnotified: clocked.filter((x) => x.c.subjectsUnnotified).length,
          last90Days: rows.filter((r) => r.discoveredAt >= ninetyDaysAgo).length,
        },
        erasurePending,
        integrityRetentionDays: school?.integrityRetentionDays ?? 0,
        consent: {
          recorded: consentRecorded,
          // The lawful-basis question a DPO asks: how many children are we holding
          // data on with nothing on file.
          studentsWithout: Math.max(0, studentRoles - consentRecorded),
        },
      };
    });
  }

  /** Students by ROLE — the same definition as the billing seat count and the
   *  operator console, so the three cannot disagree. */
  private async countStudents(tx: TenantTx): Promise<number> {
    const rows = (await tx.userRole.findMany({
      where: { role: { name: "student" } },
      select: { userId: true },
      distinct: ["userId"],
    })) as Array<{ userId: string }>;
    return rows.length;
  }
}
