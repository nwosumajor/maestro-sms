// =============================================================================
// BrandingService — per-school login-page logo
// =============================================================================
// A principal (school.branding.manage) uploads a logo for THEIR school; bytes go
// to object storage (only the key is persisted, GR: no files in Postgres). The
// PUBLIC login page fetches it by slug. The custom logo is a paid perk: it's
// hidden whenever the subscription is NOT in good standing (past-due beyond grace
// / canceled) — isSubscriptionInGoodStanding. Tenant-isolated (RLS); the public
// read resolves the school by slug (global, RLS-exempt) then runs under that
// school's GUC so the same RLS predicate applies.
// =============================================================================

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@sms/db";
import {
  isSubscriptionInGoodStanding,
  type BrandingUploadTargetDto,
  type PublicBrandingDto,
  type SchoolBrandingDto,
  type SubscriptionStatus,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { STORAGE_PROVIDER, type StorageProvider } from "../documents/storage.provider";

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

@Injectable()
export class BrandingService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private key(schoolId: string): string {
    return `schools/${schoolId}/branding/logo`;
  }

  /** Principal requests an upload target; the logoKey is recorded immediately. */
  async getUploadTarget(p: Principal, contentType: string): Promise<BrandingUploadTargetDto> {
    const key = this.key(p.schoolId);
    const presign = await this.storage.presignUpload({ key, contentType });
    await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await tx.schoolBranding.upsert({
        where: { schoolId: p.schoolId },
        update: { logoKey: key },
        create: { schoolId: p.schoolId, logoKey: key },
      });
      await this.audit.record(
        { actorId: p.userId, action: "school.branding.logo.set", entity: "school_branding", entityId: p.schoolId, schoolId: p.schoolId },
        tx,
      );
    });
    return { uploadUrl: presign.url, key };
  }

  async removeLogo(p: Principal): Promise<SchoolBrandingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.schoolBranding.findFirst({ where: { schoolId: p.schoolId } });
      if (existing?.logoKey) {
        await this.storage.delete(existing.logoKey).catch(() => undefined);
      }
      await tx.schoolBranding.upsert({
        where: { schoolId: p.schoolId },
        update: { logoKey: null },
        create: { schoolId: p.schoolId, logoKey: null },
      });
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { slug: true } });
      await this.audit.record(
        { actorId: p.userId, action: "school.branding.logo.remove", entity: "school_branding", entityId: p.schoolId, schoolId: p.schoolId },
        tx,
      );
      return { slug: school?.slug ?? "", logoKey: null, logoUrl: null };
    });
  }

  async getMyBranding(p: Principal): Promise<SchoolBrandingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { slug: true } });
      const b = await tx.schoolBranding.findFirst({ where: { schoolId: p.schoolId } });
      const logoUrl = b?.logoKey ? (await this.storage.presignDownload({ key: b.logoKey })).url : null;
      return { slug: school?.slug ?? "", logoKey: b?.logoKey ?? null, logoUrl };
    });
  }

  /** Public, pre-auth: a school's login branding by slug. Logo hidden if lapsed. */
  async getPublicBranding(slug: string): Promise<PublicBrandingDto> {
    // School registry is global / RLS-exempt — readable without a tenant GUC.
    const school = await prisma.school.findUnique({ where: { slug }, select: { id: true, name: true } });
    if (!school) throw new NotFoundException("School not found");

    const data = await this.db.runAsTenant({ schoolId: school.id, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const sub = await tx.schoolSubscription.findFirst({
        where: { schoolId: school.id },
        select: { status: true, currentPeriodEnd: true },
      });
      const branding = await tx.schoolBranding.findFirst({ where: { schoolId: school.id }, select: { logoKey: true } });
      // No subscription row ⇒ DEFAULT plan, treated as good standing.
      const goodStanding = sub
        ? isSubscriptionInGoodStanding(sub.status as SubscriptionStatus, sub.currentPeriodEnd)
        : true;
      return { logoKey: goodStanding ? (branding?.logoKey ?? null) : null };
    });

    const logoUrl = data.logoKey ? (await this.storage.presignDownload({ key: data.logoKey })).url : null;
    return { schoolName: school.name, logoUrl };
  }
}
