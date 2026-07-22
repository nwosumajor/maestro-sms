import {
  Delete, Body, Controller, Get, Param, Post, Put, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import type {
  MessageCreditBalancePageDto,
  MessageCreditLedgerEntryDto,
  OperatorAdminAppointmentDto,
  OperatorBillingAlertDto,
  OperatorStudentDto,
  OperatorUserDto,
  PlatformAnalyticsDto,
  PlatformAuditPageDto,
  SubscriptionDto,
  TenantNameDto,
  TenantPageDto,
} from "@sms/types";
import { z } from "zod";
import {
  GRACE_DAYS_MAX,
  OPERATOR_PERMISSIONS,
  PLANS,
  SUBSCRIPTION_STATUS,
  isPlan,
  isSubscriptionStatus,
  type GamesAnalyticsDto,
  type PlatformStaffDto,
  type MisplacedPlatformRoleDto,
  type SchoolDirectoryPageDto,
  type SchoolProfileDto,
} from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { OperatorService } from "./operator.service";
import { OperatorProvisioningService } from "./operator-provisioning.service";
import { OperatorUserService } from "./operator-user.service";
import { OperatorExportService } from "./operator-export.service";
import { OperatorDirectoryService } from "./operator-directory.service";
import { PlatformAnalyticsService } from "./platform-analytics.service";
import { PlatformAuditService, type PlatformAuditFilter } from "./platform-audit.service";
import { PlanPricingService } from "../billing/plan-pricing.service";
import { PlatformFeeService } from "../billing/platform-fee.service";
import { GrowthService } from "../billing/growth.service";
import { GroupService } from "../group/group.service";
import { OperatorCreditsService } from "./operator-credits.service";

const platformStaffSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
});
const staffStatusSchema = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) });
// Bounded 0..GRACE_DAYS_MAX — the cap is what makes grace DELEGABLE (bounded
// goodwill); null resets to the platform default. Unbounded comping stays with
// the owner via the subscription PUT.
const graceSchema = z.object({ graceDays: z.number().int().min(0).max(GRACE_DAYS_MAX).nullable() });
const adjustCreditsSchema = z.object({
  // Positive = comp credits, negative = debit (e.g. correcting a gateway error).
  delta: z.number().int().refine((v) => v !== 0, "delta must be non-zero"),
  note: z.string().min(3).max(200),
});

/** Parse audit query params into a typed filter (all optional). */
function auditFilter(q: Record<string, string>): PlatformAuditFilter {
  return {
    schoolId: q.schoolId || undefined,
    actorEmail: q.actorEmail || undefined,
    role: q.role || undefined,
    action: q.action || undefined,
    entity: q.entity || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    cursor: q.cursor || undefined,
  };
}

const impSchema = z.object({ schoolId: z.string().uuid(), userId: z.string().uuid() });
// NDPR bulk export: specific students (or all when omitted); medical is opt-in.
const exportSchema = z.object({
  studentIds: z.array(z.string().uuid()).max(1000).optional(),
  includeMedical: z.boolean().optional(),
});
const adminSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200).optional(),
  role: z.enum(["school_admin", "principal", "head_admin", "hr_manager"]).optional(),
});
const provisionSchema = z
  .object({
    name: z.string().min(1).max(160),
    // Optional: omitted => derived (short) from the school name, uniqueness checked.
    slug: z.string().min(2).max(40).optional(),
    plan: z.enum([PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE]).optional(),
    // Extra modules beyond the chosen plan: `enabled` force-on add-ons (the "special
    // modules" a school pays extra for); `disabled` force-off. Same shape as the
    // subscription PUT, so onboarding and later edits share one override model.
    overrides: z
      .object({
        enabled: z.array(z.string()).optional(),
        disabled: z.array(z.string()).optional(),
      })
      .optional(),
    // Onboarding seeds the founding admin tier — typically a school_admin AND a
    // principal. `admin` (single) is accepted for back-compat.
    admin: adminSchema.optional(),
    admins: z.array(adminSchema).min(1).max(6).optional(),
    // Proprietor contact + address for the operator directory (optional here —
    // provisioning falls back to the linked onboarding request's values).
    ownerName: z.string().max(160).optional(),
    ownerPhone: z.string().max(40).optional(),
    address: z.string().max(400).optional(),
    // Provisioning from a public onboarding request links + auto-APPROVEs it.
    onboardingRequestId: z.string().uuid().optional(),
    // Referral code the new school arrived with (defaults to the linked
    // onboarding request's stored code; explicit value wins for manual entry).
    referralCode: z.string().max(40).optional(),
    // Agent (reseller) attribution code — same lifecycle as referralCode.
    agentCode: z.string().max(40).optional(),
  })
  .refine((v) => Boolean(v.admin) || (v.admins && v.admins.length > 0), {
    message: "at least one admin is required",
  });
const statusSchema = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) });
const promoSchema = z.object({
  code: z.string().min(3).max(30),
  percentOff: z.number().int().min(1).max(100),
  maxUses: z.number().int().min(1).nullish(),
  expiresAt: z.string().datetime().nullish(),
});
const agentSchema = z.object({
  name: z.string().min(1).max(160),
  email: z.string().email(),
  code: z.string().min(3).max(30),
  commissionBp: z.number().int().min(1).max(5000),
});
const activeSchema = z.object({ active: z.boolean() });
const groupSchema = z.object({ name: z.string().min(1).max(160) });
const groupMembersSchema = z.object({ schoolIds: z.array(z.string().uuid()).max(50) });
const groupDirectorsSchema = z.object({ emails: z.array(z.string().email()).max(10) });

const platformFeeSchema = z.object({
  flatMinor: z.number().int().min(0),
  percentBp: z.number().int().min(0),
  capMinor: z.number().int().min(0).nullish(),
  bearer: z.enum(["PARENT", "SCHOOL"]),
});
const requiredSchema = z.object({ required: z.boolean() });
const onboardingStatusSchema = z.object({
  status: z.enum(["NEW", "REVIEWING", "APPROVED", "REJECTED"]),
  note: z.string().max(1000).optional(),
});
const subSchema = z.object({
  plan: z.enum([PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE]),
  overrides: z
    .object({
      enabled: z.array(z.string()).optional(),
      disabled: z.array(z.string()).optional(),
    })
    .optional(),
  // super_admin comp/grant: force a status and/or extend the paid period.
  status: z.enum([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.CANCELED]).optional(),
  currentPeriodEnd: z.string().datetime().nullable().optional(),
});
const pricingSchema = z.object({
  prices: z
    .array(
      z.object({
        plan: z.enum([PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE]),
        perSeatMonthlyMinor: z.number().int().positive(),
        // NGN default (back-compat). ENTERPRISE accepts USD only (service-enforced).
        currency: z.enum(["NGN", "USD"]).optional(),
      }),
    )
    .min(1)
    // One row per sellable (tier, currency): 3 NGN + 4 USD.
    .max(7),
});

@Controller("operator")
export class OperatorController {
  constructor(
    private readonly operator: OperatorService,
    private readonly provisioning: OperatorProvisioningService,
    private readonly users: OperatorUserService,
    private readonly exporter: OperatorExportService,
    private readonly directorySvc: OperatorDirectoryService,
    private readonly analyticsSvc: PlatformAnalyticsService,
    private readonly auditSvc: PlatformAuditService,
    private readonly pricing: PlanPricingService,
    private readonly platformFees: PlatformFeeService,
    private readonly growth: GrowthService,
    private readonly groups: GroupService,
    private readonly credits: OperatorCreditsService,
  ) {}

  /** Self-serve onboard a NEW school + its first admin (step-up: creates creds). */
  @Post("tenants")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_WRITE)
  @RequireStepUp()
  provision(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(provisionSchema)) body: z.infer<typeof provisionSchema>,
  ) {
    return this.provisioning.provisionSchool(p, body);
  }

  /** Add another admin user to an existing school (step-up: creates creds). */
  @Post("tenants/:schoolId/admins")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_WRITE)
  @RequireStepUp()
  addAdmin(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Body(new ZodValidationPipe(adminSchema)) body: z.infer<typeof adminSchema>,
  ) {
    return this.provisioning.createAdmin(p, schoolId, body);
  }

  /** AUDIT: platform-tier roles held outside the platform org (should be none). */
  @Get("platform-role-audit")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_STAFF_MANAGE)
  platformRoleAudit(@CurrentPrincipal() p: Principal): Promise<MisplacedPlatformRoleDto[]> {
    return this.provisioning.listMisplacedPlatformRoles(p);
  }

  /** Strip a misplaced platform-tier grant. The ACCOUNT is untouched. */
  @Delete("platform-role-audit/:userId/:roleName")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_STAFF_MANAGE)
  @RequireStepUp()
  revokeMisplacedPlatformRole(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Param("roleName") roleName: string,
  ) {
    return this.provisioning.revokeMisplacedPlatformRole(p, userId, roleName);
  }

  // --- platform staff (the owner hiring help) — OWNER-ONLY -----------------
  /** Current platform managers. */
  @Get("platform-staff")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_STAFF_MANAGE)
  listPlatformStaff(@CurrentPrincipal() p: Principal): Promise<PlatformStaffDto[]> {
    return this.provisioning.listPlatformStaff(p);
  }

  /** Hire a platform manager (manager_admin). Step-up: creates an identity with
   *  cross-tenant reach. Invite-link only — no password is ever returned. */
  @Post("platform-staff")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_STAFF_MANAGE)
  @RequireStepUp()
  createPlatformStaff(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(platformStaffSchema)) body: z.infer<typeof platformStaffSchema>,
  ): Promise<PlatformStaffDto> {
    return this.provisioning.createPlatformStaff(p, body);
  }

  /** Revoke / reinstate a platform manager. Step-up: destructive. */
  @Put("platform-staff/:userId/status")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_STAFF_MANAGE)
  @RequireStepUp()
  setPlatformStaffStatus(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(staffStatusSchema)) body: z.infer<typeof staffStatusSchema>,
  ): Promise<PlatformStaffDto> {
    return this.provisioning.setPlatformStaffStatus(p, userId, body.status);
  }

  @Get("tenants")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  tenants(
    @CurrentPrincipal() p: Principal,
    @Query("q") q?: string,
    @Query("plan") plan?: string,
    @Query("billing") billing?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ): Promise<TenantPageDto> {
    return this.operator.listTenants(p, {
      q: q?.trim() || undefined,
      plan: plan && isPlan(plan) ? plan : undefined,
      billing: billing && isSubscriptionStatus(billing) ? billing : undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** Searchable school directory: proprietor + admin/principal contacts,
   *  onboarding date, subscription posture, last payment, seat arrears. */
  @Get("directory")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  directory(
    @CurrentPrincipal() p: Principal,
    @Query("q") q?: string,
    @Query("plan") plan?: string,
    @Query("billing") billing?: string,
    @Query("status") status?: string,
    @Query("sort") sort?: string,
    @Query("page") page?: string,
  ): Promise<SchoolDirectoryPageDto> {
    return this.directorySvc.listDirectory(p, {
      q: q?.trim() || undefined,
      plan: plan && isPlan(plan) ? plan : undefined,
      billing: billing && isSubscriptionStatus(billing) ? billing : undefined,
      status: status === "ACTIVE" || status === "DISABLED" ? status : undefined,
      sort: sort === "recent" ? "recent" : undefined,
      page: page ? Number(page) : undefined,
    });
  }

  /** The complete operator-facing profile of one school. */
  @Get("schools/:schoolId/profile")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  schoolProfile(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
  ): Promise<SchoolProfileDto> {
    return this.directorySvc.schoolProfile(p, schoolId);
  }

  /** Lightweight id+name list for pickers (add-admin etc.). */
  @Get("tenant-names")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  tenantNames(@CurrentPrincipal() p: Principal): Promise<TenantNameDto[]> {
    return this.operator.listTenantNames(p);
  }

  /** Enable/disable a SCHOOL — the hard deactivation lever (blocks every member
   *  login; nothing deleted). Step-up: outage-grade action. */
  @Put("tenants/:schoolId/status")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_STATUS)
  @RequireStepUp()
  schoolStatus(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.operator.setSchoolStatus(p, schoolId, body.status);
  }

  /** Tenants currently past their paid period (red banner on the console). */
  @Get("billing-alerts")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  billingAlerts(): Promise<OperatorBillingAlertDto[]> {
    return this.operator.listBillingAlerts();
  }

  /** Cross-tenant oversight of junior-admin appointments (ADMIN_APPOINTMENT
   *  maker-checker requests): who is being appointed into each school's admin
   *  tier and whether the second senior has decided. ?state= filters (e.g.
   *  PENDING_REVIEW). Staff names only — never student data. */
  @Get("admin-appointments")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  adminAppointments(@Query("state") state?: string): Promise<OperatorAdminAppointmentDto[]> {
    return this.operator.listAdminAppointments(state);
  }

  /** Platform-owner business dashboard: cross-tenant schools/revenue/plan metrics. */
  @Get("analytics")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  async analytics(@CurrentPrincipal() p: Principal): Promise<PlatformAnalyticsDto> {
    const result = await this.analyticsSvc.overview(p);
    await this.analyticsSvc.auditView(p);
    return result;
  }

  /** Fleet-wide GAMES adoption/engagement — aggregate counts only, PII-free. */
  @Get("games-analytics")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  async gamesAnalytics(@CurrentPrincipal() p: Principal): Promise<GamesAnalyticsDto> {
    const result = await this.analyticsSvc.games(p);
    await this.analyticsSvc.auditGamesView(p);
    return result;
  }

  /** Cross-tenant audit trail: every change/approval, attributed to actor
   *  email + unique id + roles + school. For oversight and investigation. */
  @Get("audit")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_AUDIT_READ)
  audit(
    @CurrentPrincipal() p: Principal,
    @Query() q: Record<string, string>,
  ): Promise<PlatformAuditPageDto> {
    return this.auditSvc.list(p, auditFilter(q));
  }

  /** Downloadable CSV of the same audit query — an exportable report. */
  @Get("audit/export.csv")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_AUDIT_READ)
  async auditExport(
    @CurrentPrincipal() p: Principal,
    @Query() q: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { csv, filename } = await this.auditSvc.exportCsv(p, auditFilter(q));
    res.set({ "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${filename}"` });
    return new StreamableFile(Buffer.from(csv, "utf8"));
  }

  /** Impersonation requires a fresh step-up — the riskiest action in the system. */
  @Post("impersonate")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_IMPERSONATE)
  @RequireStepUp()
  impersonate(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(impSchema)) body: { schoolId: string; userId: string },
  ) {
    return this.operator.impersonate(p, body.schoolId, body.userId);
  }

  // --- subscription / module entitlements (super_admin) -------------------
  @Get("tenants/:schoolId/subscription")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  getSubscription(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
  ): Promise<SubscriptionDto> {
    return this.operator.getSubscription(p, schoolId);
  }

  @Put("tenants/:schoolId/subscription")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_SUBSCRIPTION_MANAGE)
  setSubscription(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Body(new ZodValidationPipe(subSchema)) body: z.infer<typeof subSchema>,
  ): Promise<SubscriptionDto> {
    return this.operator.setSubscription(p, schoolId, body);
  }

  // --- platform-wide plan-tier pricing (super_admin) ------------------------
  /** Per-school grace window. DELEGABLE (manager_admin): hard-capped by the
   *  schema, so it is customer-service leeway, never a comp. Step-up: it delays
   *  a revenue-enforcing downgrade. Audited. */
  @Put("tenants/:schoolId/grace")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_GRACE_MANAGE)
  @RequireStepUp()
  setGraceDays(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Body(new ZodValidationPipe(graceSchema)) body: z.infer<typeof graceSchema>,
  ): Promise<SubscriptionDto> {
    return this.operator.setGraceDays(p, schoolId, body.graceDays);
  }

  /** Effective per-tier pricing (defaults + operator overrides). */
  @Get("pricing")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  getPricing() {
    return this.pricing.list();
  }

  /** Set per-tier prices. Step-up: platform-wide money configuration. Audited. */
  @Put("pricing")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_PRICING_MANAGE)
  @RequireStepUp()
  setPricing(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(pricingSchema)) body: z.infer<typeof pricingSchema>,
  ) {
    return this.pricing.update(p, body);
  }

  /** The platform's convenience fee on online fee collection (take-rate). */
  @Get("platform-fees")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  getPlatformFees() {
    return this.platformFees.effective();
  }

  // --- message credits (SMS/WhatsApp) oversight — super_admin ----------------
  /** Cross-tenant balance list — every school's current SMS/WhatsApp credit
   *  position, searchable by name. Delegable oversight, like the tenant registry. */
  @Get("message-credits")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  listCreditBalances(
    @CurrentPrincipal() p: Principal,
    @Query("q") q?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ): Promise<MessageCreditBalancePageDto> {
    return this.credits.listBalances(p, {
      q,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** One school's credit ledger (purchases, sends, comps), newest first. */
  @Get("message-credits/:schoolId/ledger")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  listCreditLedger(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
  ): Promise<MessageCreditLedgerEntryDto[]> {
    return this.credits.listLedger(p, schoolId);
  }

  /** Comp or debit a school's credit balance. Owner-only revenue lever, same
   *  posture as the subscription comp: step-up + audited. */
  @Post("message-credits/:schoolId/adjust")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_SUBSCRIPTION_MANAGE)
  @RequireStepUp()
  adjustCredits(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Body(new ZodValidationPipe(adjustCreditsSchema)) body: z.infer<typeof adjustCreditsSchema>,
  ) {
    return this.credits.adjust(p, schoolId, body.delta, body.note);
  }

  /** Set the take-rate. Same posture as pricing: owner-only, step-up, audited. */
  @Put("platform-fees")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_PRICING_MANAGE)
  @RequireStepUp()
  setPlatformFees(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(platformFeeSchema)) body: z.infer<typeof platformFeeSchema>,
  ) {
    return this.platformFees.update(p, { ...body, capMinor: body.capMinor ?? null });
  }

  // --- growth: promo codes + agents/commissions (owner-only writes) ----------
  @Get("promos")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  listPromos() {
    return this.growth.listPromos();
  }

  @Post("promos")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_PRICING_MANAGE)
  @RequireStepUp()
  createPromo(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(promoSchema)) body: z.infer<typeof promoSchema>,
  ) {
    return this.growth.createPromo(p, body);
  }

  @Put("promos/:id/active")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_PRICING_MANAGE)
  @RequireStepUp()
  setPromoActive(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(activeSchema)) body: z.infer<typeof activeSchema>,
  ) {
    return this.growth.setPromoActive(p, id, body.active);
  }

  @Get("agents")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  listAgents() {
    return this.growth.listAgents();
  }

  @Post("agents")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_PRICING_MANAGE)
  @RequireStepUp()
  createAgent(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(agentSchema)) body: z.infer<typeof agentSchema>,
  ) {
    return this.growth.createAgent(p, body);
  }

  @Put("agents/:id/active")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_PRICING_MANAGE)
  @RequireStepUp()
  setAgentActive(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(activeSchema)) body: z.infer<typeof activeSchema>,
  ) {
    return this.growth.setAgentActive(p, id, body.active);
  }

  @Get("commissions")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  listCommissions() {
    return this.growth.listCommissions();
  }

  /** Mark a commission settled to the agent (money moved outside the system). */
  @Post("commissions/:id/paid")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_PRICING_MANAGE)
  @RequireStepUp()
  markCommissionPaid(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.growth.markCommissionPaid(p, id);
  }

  // --- multi-school groups (franchise tier; owner-only writes) ----------------
  @Get("groups")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ)
  listGroups() {
    return this.groups.listGroups();
  }

  @Post("groups")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_SUBSCRIPTION_MANAGE)
  @RequireStepUp()
  createGroup(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(groupSchema)) body: z.infer<typeof groupSchema>,
  ) {
    return this.groups.createGroup(p, body.name);
  }

  /** Replace a group's member schools. Step-up: it widens a cross-tenant read. */
  @Put("groups/:id/members")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_SUBSCRIPTION_MANAGE)
  @RequireStepUp()
  setGroupMembers(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(groupMembersSchema)) body: z.infer<typeof groupMembersSchema>,
  ) {
    return this.groups.setMembers(p, id, body.schoolIds);
  }

  /** Replace a group's directors (by email; must belong to a member school). */
  @Put("groups/:id/directors")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_SUBSCRIPTION_MANAGE)
  @RequireStepUp()
  setGroupDirectors(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(groupDirectorsSchema)) body: z.infer<typeof groupDirectorsSchema>,
  ) {
    return this.groups.setDirectors(p, id, body.emails);
  }

  // --- public onboarding-request review (super_admin) ------------------------
  @Get("onboarding-requests")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_ONBOARDING_REVIEW)
  onboardingRequests(@CurrentPrincipal() p: Principal) {
    return this.provisioning.listOnboardingRequests(p);
  }

  @Post("onboarding-requests/:id/status")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_ONBOARDING_REVIEW)
  setOnboardingStatus(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(onboardingStatusSchema)) body: z.infer<typeof onboardingStatusSchema>,
  ) {
    return this.provisioning.setOnboardingRequestStatus(p, id, body.status, body.note);
  }

  /** Every enrolled student of a school (cross-tenant; audited). */
  @Get("tenants/:schoolId/students")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_STUDENT_READ)
  listSchoolStudents(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
  ): Promise<OperatorStudentDto[]> {
    return this.operator.listSchoolStudents(p, schoolId);
  }

  /** NDPR bulk export of a school's student data (records requested by the school,
   *  e.g. years later). Runs under the target school's RLS context; medical is
   *  opt-in. super_admin only, step-up, audited. */
  @Post("tenants/:schoolId/students/export")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_STUDENT_READ)
  @RequireStepUp()
  exportStudents(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Body(new ZodValidationPipe(exportSchema)) body: z.infer<typeof exportSchema>,
  ) {
    return this.exporter.exportStudents(p, schoolId, body);
  }

  // --- cross-tenant user directory + governance (super_admin) ----------------
  @Get("tenants/:schoolId/users")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_USER_READ)
  listUsers(
    @CurrentPrincipal() _p: Principal,
    @Param("schoolId") schoolId: string,
  ): Promise<OperatorUserDto[]> {
    return this.users.listUsers(schoolId);
  }

  /** Suspend / reactivate an account (DISABLED blocks login). Step-up: destructive. */
  @Put("tenants/:schoolId/users/:userId/status")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_USER_CREDENTIALS)
  @RequireStepUp()
  setUserStatus(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.users.setStatus(p, schoolId, userId, body.status);
  }

  /** Clear a lockout (failed-login counters). */
  @Post("tenants/:schoolId/users/:userId/unlock")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_USER_UNLOCK)
  unlockUser(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("userId") userId: string,
  ) {
    return this.users.unlock(p, schoolId, userId);
  }

  /** Issue a one-time temp password (shown once). Step-up: credential change. */
  @Post("tenants/:schoolId/users/:userId/reset-password")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_USER_CREDENTIALS)
  @RequireStepUp()
  resetUserPassword(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("userId") userId: string,
  ) {
    return this.users.resetPassword(p, schoolId, userId);
  }

  /** Reset (disable) a user's TOTP MFA. Step-up: weakens an auth factor. */
  @Post("tenants/:schoolId/users/:userId/mfa/reset")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_USER_CREDENTIALS)
  @RequireStepUp()
  resetUserMfa(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("userId") userId: string,
  ) {
    return this.users.resetMfa(p, schoolId, userId);
  }

  /** Mandate / release MFA enrolment for a single user. */
  @Put("tenants/:schoolId/users/:userId/mfa-required")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_USER_CREDENTIALS)
  setUserMfaRequired(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(requiredSchema)) body: z.infer<typeof requiredSchema>,
  ) {
    return this.users.setMfaRequired(p, schoolId, userId, body.required);
  }

  /** Mandate / release MFA for every user holding a role. */
  @Put("tenants/:schoolId/roles/:roleName/mfa-required")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_USER_CREDENTIALS)
  setRoleMfaRequired(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("roleName") roleName: string,
    @Body(new ZodValidationPipe(requiredSchema)) body: z.infer<typeof requiredSchema>,
  ) {
    return this.users.setRoleMfaRequired(p, schoolId, roleName, body.required);
  }
}
