// =============================================================================
// OperatorDirectoryService — the platform owner's searchable school directory
// =============================================================================
// A CRM-grade registry of every onboarded school: proprietor contact, the
// school_admin/principal accounts (name + phone), onboarding date, subscription
// posture, last payment and outstanding seat arrears — plus a complete
// per-school profile. Gated platform.tenants.read (delegable oversight; carries
// staff BUSINESS contacts, never student PII — cross-tenant student reads stay
// owner-only behind platform.student.read).
//
// Query posture mirrors listTenants: the school registry page/search runs on
// the global (RLS-exempt) school table; per-school enrichment runs under EACH
// school's own GUC via runAsTenant (app role — RLS intact); only filters that
// must see the tenant-scoped subscription table across tenants use the
// PRIVILEGED client (503 when unconfigured, same trade listTenants makes).
// Enrichment cost is pageSize-bounded, never fleet-size.
// =============================================================================

import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  DEFAULT_PLAN,
  type SchoolContactDto,
  type SchoolDirectoryPageDto,
  type SchoolDirectoryRowDto,
  type SchoolProfileDto,
} from "@sms/types";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { ModuleEntitlementService } from "../foundation/module-entitlement.service";

type SchoolRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  ownerName: string | null;
  ownerPhone: string | null;
  address: string | null;
};

const PROFILE_SCHOOL_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  createdAt: true,
  ownerName: true,
  ownerPhone: true,
  address: true,
} as const;

@Injectable()
export class OperatorDirectoryService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly entitlements: ModuleEntitlementService,
  ) {}

  /** Search/filter/paged school directory. `q` matches name, slug, owner name
   *  and owner phone; `plan`/`billing` filter the subscription (privileged);
   *  `status` filters the school itself (ACTIVE | DISABLED). */
  async listDirectory(
    p: Principal,
    f: { q?: string; plan?: string; billing?: string; status?: string; sort?: string; page?: number } = {},
  ): Promise<SchoolDirectoryPageDto> {
    const page = Math.max(1, Math.floor(f.page ?? 1));
    const pageSize = 20;
    const sub: Record<string, string> = {};
    if (f.plan) sub.plan = f.plan;
    if (f.billing) sub.status = f.billing;
    const where = {
      isPlatform: false,
      ...(f.status ? { status: f.status } : {}),
      ...(f.q
        ? {
            OR: [
              { name: { contains: f.q, mode: "insensitive" as const } },
              { slug: { contains: f.q, mode: "insensitive" as const } },
              { ownerName: { contains: f.q, mode: "insensitive" as const } },
              { ownerPhone: { contains: f.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(Object.keys(sub).length ? { subscription: { is: sub } } : {}),
    };
    const client = this.privileged.client;
    if (Object.keys(sub).length > 0 && !client) {
      throw new ServiceUnavailableException("Plan/billing filters require the privileged database configuration");
    }
    const query = {
      where,
      select: PROFILE_SCHOOL_SELECT,
      orderBy: f.sort === "recent" ? { createdAt: "desc" as const } : { name: "asc" as const },
      skip: (page - 1) * pageSize,
      take: pageSize,
    };
    const { schools, total } = client
      ? { total: await client.school.count({ where }), schools: await client.school.findMany(query) }
      : await this.db.runAsTenant(this.ctx(p), async (tx) => ({
          total: await tx.school.count({ where }),
          schools: await tx.school.findMany(query),
        }));

    const rows: SchoolDirectoryRowDto[] = [];
    for (const s of schools as SchoolRow[]) {
      rows.push(await this.enrichRow(p, s));
    }
    return { rows, total, page, pageSize };
  }

  /** The complete operator-facing profile of one school. */
  async schoolProfile(p: Principal, schoolId: string): Promise<SchoolProfileDto> {
    const query = {
      where: { id: schoolId, isPlatform: false },
      select: {
        ...PROFILE_SCHOOL_SELECT,
        settlementBankName: true,
        settlementAccountLast4: true,
        admissionFormFeeMinor: true,
      },
    };
    const client = this.privileged.client;
    const school = client
      ? await client.school.findFirst(query)
      : await this.db.runAsTenant(this.ctx(p), (tx) => tx.school.findFirst(query));
    // 404-not-403 even for the operator: don't oracle which ids exist.
    if (!school) throw new NotFoundException("School not found");

    const row = await this.enrichRow(p, school);
    const detail = await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const contacts = await this.contactsIn(tx);
      const staff = await tx.userRole.count({
        where: { role: { name: { notIn: ["student", "parent"] } } },
      });
      const sub = await tx.schoolSubscription.findFirst({
        where: { schoolId },
        select: {
          billingCycle: true,
          seats: true,
          priceMinor: true,
          currency: true,
          graceDays: true,
          autoRenew: true,
          cardLast4: true,
          referredBySchoolId: true,
        },
      });
      const payments = await tx.platformSubscriptionPayment.findMany({
        where: { schoolId },
        select: { reference: true, kind: true, status: true, amountMinor: true, currency: true, createdAt: true, paidAt: true },
        orderBy: { createdAt: "desc" },
        take: 12,
      });
      return { contacts, staff, sub, payments };
    });
    // Referrer name lives on ANOTHER tenant's registry row — global table read.
    const referredBy = detail.sub?.referredBySchoolId
      ? await this.db.runAsTenant(this.ctx(p), (tx) =>
          tx.school.findFirst({ where: { id: detail.sub!.referredBySchoolId! }, select: { name: true } }),
        )
      : null;
    const ent = await this.entitlements.resolve(schoolId);

    return {
      ...row,
      admins: detail.contacts.admins,
      principals: detail.contacts.principals,
      staff: detail.staff,
      billingCycle: detail.sub?.billingCycle ?? "TERM",
      seats: detail.sub?.seats ?? null,
      priceMinor: detail.sub?.priceMinor ?? null,
      currency: detail.sub?.currency ?? null,
      graceDays: detail.sub?.graceDays ?? null,
      autoRenew: detail.sub?.autoRenew ?? false,
      cardLast4: detail.sub?.cardLast4 ?? null,
      effectivePlan: ent.plan,
      modules: [...ent.modules],
      settlementBankName: (school as { settlementBankName?: string | null }).settlementBankName ?? null,
      settlementAccountLast4: (school as { settlementAccountLast4?: string | null }).settlementAccountLast4 ?? null,
      admissionFormFeeMinor: (school as { admissionFormFeeMinor?: number }).admissionFormFeeMinor ?? 0,
      referredBy: referredBy?.name ?? null,
      payments: detail.payments,
    };
  }

  // --- internals --------------------------------------------------------------

  /** One directory row: per-school enrichment under the school's OWN GUC. */
  private async enrichRow(p: Principal, s: SchoolRow): Promise<SchoolDirectoryRowDto> {
    const e = await this.db.runAsTenant({ schoolId: s.id, userId: p.userId }, async (tx) => {
      const contacts = await this.contactsIn(tx);
      const students = await tx.userRole.count({ where: { role: { name: "student" } } });
      const users = await tx.user.count();
      const sub = await tx.schoolSubscription.findFirst({
        where: { schoolId: s.id },
        select: { plan: true, status: true, currentPeriodEnd: true, seatArrearsMinor: true },
      });
      const lastPaid = await tx.platformSubscriptionPayment.findFirst({
        where: { schoolId: s.id, status: "PAID" },
        select: { paidAt: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      });
      return { contacts, students, users, sub, lastPaid };
    });
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      status: s.status,
      ownerName: s.ownerName,
      ownerPhone: s.ownerPhone,
      address: s.address,
      admin: e.contacts.admins[0] ?? null,
      principal: e.contacts.principals[0] ?? null,
      onboardedAt: s.createdAt,
      plan: e.sub?.plan ?? DEFAULT_PLAN,
      subscriptionStatus: e.sub?.status ?? "ACTIVE",
      currentPeriodEnd: e.sub?.currentPeriodEnd ?? null,
      lastPaymentAt: e.lastPaid?.paidAt ?? e.lastPaid?.createdAt ?? null,
      outstandingMinor: e.sub?.seatArrearsMinor ?? 0,
      students: e.students,
      users: e.users,
    };
  }

  /** The school's admin/principal ACCOUNT holders (name/email/phone). */
  private async contactsIn(tx: TenantTx): Promise<{ admins: SchoolContactDto[]; principals: SchoolContactDto[] }> {
    const holders = await tx.userRole.findMany({
      where: { role: { name: { in: ["school_admin", "principal"] } } },
      select: {
        role: { select: { name: true } },
        user: { select: { name: true, email: true, phone: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const pick = (roleName: string): SchoolContactDto[] =>
      holders
        .filter((h: { role: { name: string } }) => h.role.name === roleName)
        .map((h: { user: { name: string; email: string; phone: string | null } }) => ({
          name: h.user.name,
          email: h.user.email,
          phone: h.user.phone ?? null,
        }));
    return { admins: pick("school_admin"), principals: pick("principal") };
  }

  private ctx(p: Principal) {
    return { schoolId: p.schoolId, userId: p.userId };
  }
}
