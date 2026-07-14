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

import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { prisma } from "@sms/db";
import {
  isSubscriptionInGoodStanding,
  type MemberBrandingDto,
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
import { RedisPubSubService } from "../common/redis-pubsub.service";
import { TenantCache } from "../common/tenant-cache";

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

// Branding is read on nearly every page load (signed-in shell + public login) and
// changes only when a school edits its logo/theme — a textbook read-through cache
// target. We cache the DB-DERIVED data (name/theme/logoKey) and re-presign the
// logo URL OUTSIDE the cache, so a short-lived signed URL is never served stale.
const BRANDING_CACHE_TTL_MS = 60_000;

interface MemberBrandingData {
  schoolName: string;
  branding: { brandHue?: number | null; brandSat?: number | null; brandLight?: number | null; fontFamily?: string | null } | null;
  logoKey: string | null;
}
interface PublicBrandingData {
  schoolId: string;
  schoolName: string;
  logoKey: string | null;
}

@Injectable()
export class BrandingService {
  private readonly memberCache: TenantCache<MemberBrandingData>;
  private readonly publicCache: TenantCache<PublicBrandingData>;

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Optional() pubsub?: RedisPubSubService,
  ) {
    this.memberCache = new TenantCache("branding-member", BRANDING_CACHE_TTL_MS, pubsub);
    this.publicCache = new TenantCache("branding-public", BRANDING_CACHE_TTL_MS, pubsub);
  }

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Drop both caches for a school after a branding write. Public keyed by slug. */
  private invalidateBranding(schoolId: string, slug?: string | null): void {
    this.memberCache.invalidate(schoolId);
    if (slug) this.publicCache.invalidate(slug);
  }
  private key(schoolId: string): string {
    return `schools/${schoolId}/branding/logo`;
  }

  /** Direct logo upload: the API stores the bytes itself (so it can later embed the
   *  logo into generated certificates / report cards). Principal / school_admin only. */
  async uploadLogo(p: Principal, body: Buffer, contentType: string): Promise<SchoolBrandingDto> {
    const key = this.key(p.schoolId);
    await this.storage.upload({ key, body, contentType });
    const out = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const b = await tx.schoolBranding.upsert({
        where: { schoolId: p.schoolId },
        update: { logoKey: key },
        create: { schoolId: p.schoolId, logoKey: key },
      });
      await this.audit.record(
        { actorId: p.userId, action: "school.branding.logo.set", entity: "school_branding", entityId: p.schoolId, schoolId: p.schoolId, metadata: { bytes: body.length } },
        tx,
      );
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { slug: true } });
      const logoUrl = (await this.storage.presignDownload({ key })).url;
      return this.dto(school?.slug ?? "", logoUrl, b);
    });
    this.invalidateBranding(p.schoolId, out.slug);
    return out;
  }

  /** The school's logo bytes (for server-side PDF embedding), or null if unset. */
  async getLogoBytes(schoolId: string): Promise<Buffer | null> {
    const row = await this.db.runAsTenant({ schoolId, userId: "system" }, (tx) =>
      tx.schoolBranding.findFirst({ where: { schoolId }, select: { logoKey: true } }),
    );
    if (!row?.logoKey) return null;
    return this.storage.download(row.logoKey);
  }

  async removeLogo(p: Principal): Promise<SchoolBrandingDto> {
    const out = await this.db.runAsTenant(this.ctx(p), async (tx) => {
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
      const b = await tx.schoolBranding.findFirst({ where: { schoolId: p.schoolId } });
      return this.dto(school?.slug ?? "", null, b);
    });
    this.invalidateBranding(p.schoolId, out.slug);
    return out;
  }

  /** Set the per-school theme (brand colour HSL + font). Null clears a field. */
  async setTheme(
    p: Principal,
    input: { brandHue?: number | null; brandSat?: number | null; brandLight?: number | null; fontFamily?: string | null },
  ): Promise<SchoolBrandingDto> {
    const out = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await tx.schoolBranding.upsert({
        where: { schoolId: p.schoolId },
        update: { ...input },
        create: { schoolId: p.schoolId, ...input },
      });
      await this.audit.record(
        { actorId: p.userId, action: "school.branding.theme.set", entity: "school_branding", entityId: p.schoolId, schoolId: p.schoolId, metadata: { fields: Object.keys(input) } },
        tx,
      );
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { slug: true } });
      const b = await tx.schoolBranding.findFirst({ where: { schoolId: p.schoolId } });
      const logoUrl = b?.logoKey ? (await this.storage.presignDownload({ key: b.logoKey })).url : null;
      return this.dto(school?.slug ?? "", logoUrl, b);
    });
    this.invalidateBranding(p.schoolId, out.slug);
    return out;
  }

  async getMyBranding(p: Principal): Promise<SchoolBrandingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { slug: true } });
      const b = await tx.schoolBranding.findFirst({ where: { schoolId: p.schoolId } });
      const logoUrl = b?.logoKey ? (await this.storage.presignDownload({ key: b.logoKey })).url : null;
      return this.dto(school?.slug ?? "", logoUrl, b);
    });
  }

  private dto(
    slug: string,
    logoUrl: string | null,
    b: { logoKey?: string | null; brandHue?: number | null; brandSat?: number | null; brandLight?: number | null; fontFamily?: string | null } | null,
  ): SchoolBrandingDto {
    return {
      slug,
      logoKey: b?.logoKey ?? null,
      logoUrl,
      brandHue: b?.brandHue ?? null,
      brandSat: b?.brandSat ?? null,
      brandLight: b?.brandLight ?? null,
      fontFamily: b?.fontFamily ?? null,
    };
  }

  /** Any authenticated member of the school: logo + theme for the signed-in shell.
   *  Read-only, tenant-scoped by the caller's JWT (RLS backstops); no manage
   *  permission needed. The custom logo stays a paid perk — hidden when the
   *  subscription is out of good standing, exactly like the public login page. */
  async getMemberBranding(p: Principal): Promise<MemberBrandingDto> {
    const data = await this.memberCache.get(p.schoolId, () =>
      this.db.runAsTenant(this.ctx(p), async (tx): Promise<MemberBrandingData> => {
        const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } });
        const b = await tx.schoolBranding.findFirst({ where: { schoolId: p.schoolId } });
        const sub = await tx.schoolSubscription.findFirst({
          where: { schoolId: p.schoolId },
          select: { status: true, currentPeriodEnd: true },
        });
        // No subscription row ⇒ DEFAULT plan, treated as good standing.
        const goodStanding = sub
          ? isSubscriptionInGoodStanding(sub.status as SubscriptionStatus, sub.currentPeriodEnd)
          : true;
        return { schoolName: school?.name ?? "", branding: b, logoKey: goodStanding ? (b?.logoKey ?? null) : null };
      }),
    );
    // Presign OUTSIDE the cache — the signed URL has its own short lifetime.
    const logoUrl = data.logoKey ? (await this.storage.presignDownload({ key: data.logoKey })).url : null;
    return {
      schoolName: data.schoolName,
      logoUrl,
      brandHue: data.branding?.brandHue ?? null,
      brandSat: data.branding?.brandSat ?? null,
      brandLight: data.branding?.brandLight ?? null,
      fontFamily: data.branding?.fontFamily ?? null,
    };
  }

  /** Public, pre-auth: a school's login branding by slug. Logo hidden if lapsed. */
  async getPublicBranding(slug: string): Promise<PublicBrandingDto> {
    const data = await this.publicCache.get(slug, async (): Promise<PublicBrandingData> => {
      // School registry is global / RLS-exempt — readable without a tenant GUC.
      const school = await prisma.school.findUnique({ where: { slug }, select: { id: true, name: true } });
      if (!school) throw new NotFoundException("School not found");
      const gated = await this.db.runAsTenant({ schoolId: school.id, userId: SYSTEM_ACTOR_ID }, async (tx) => {
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
      return { schoolId: school.id, schoolName: school.name, logoKey: gated.logoKey };
    });

    // Presign OUTSIDE the cache — the signed URL has its own short lifetime.
    const logoUrl = data.logoKey ? (await this.storage.presignDownload({ key: data.logoKey })).url : null;
    return { schoolName: data.schoolName, logoUrl };
  }
}
