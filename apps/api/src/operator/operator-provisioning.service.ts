// =============================================================================
// OperatorProvisioningService — super_admin self-serve school onboarding
// =============================================================================
// Creating a SCHOOL writes the GLOBAL registry (school/role/permission), and
// creating users/roles for an arbitrary tenant crosses the RLS boundary — neither
// is permitted to the least-privilege app role (`major_user` has SELECT-only on
// the global tables). So, exactly like the retention/dunning jobs, provisioning
// connects through a PRIVILEGED client (DATABASE_MIGRATE_URL, else
// DATABASE_RETENTION_URL) that bypasses RLS by design. It is reachable ONLY from
// the platform.operate + step-up-gated operator endpoints, and every action is
// audit-logged in the operator's own tenant.
//
// Least-privilege default: with no privileged URL the client is null and
// provisioning is DISABLED (503) rather than silently escalating.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@sms/db";
import { DEFAULT_PLAN, isPlan } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { Inject } from "@nestjs/common";

// Roles a super_admin may seed into a school via provisioning (the admin tier).
const ADMIN_ROLES = new Set(["school_admin", "principal", "head_admin", "hr_manager"]);

interface AdminInput {
  name: string;
  email: string;
  password?: string;
  role?: string;
}

@Injectable()
export class OperatorProvisioningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("OperatorProvisioning");
  private _client: PrismaClient | null = null;

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  onModuleInit(): void {
    const url = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_RETENTION_URL;
    if (!url) {
      this.logger.warn(
        "No DATABASE_MIGRATE_URL / DATABASE_RETENTION_URL set — school provisioning is DISABLED.",
      );
      return;
    }
    this._client = new PrismaClient({ datasourceUrl: url, log: ["error"] });
  }
  async onModuleDestroy(): Promise<void> {
    await this._client?.$disconnect();
  }

  private client(): PrismaClient {
    if (!this._client) {
      throw new ServiceUnavailableException("School provisioning is not configured");
    }
    return this._client;
  }

  private genPassword(): string {
    return crypto.randomBytes(9).toString("base64url");
  }

  /**
   * Create a school + its subscription + its FOUNDING admin tier. Onboarding seeds
   * at least a school_admin AND (recommended) a principal; those two then staff the
   * rest of the school themselves (POST /admin/users). Returns one-time creds per
   * admin. Accepts a single `admin` (legacy) or an `admins[]`.
   */
  async provisionSchool(
    p: Principal,
    input: {
      name: string;
      slug: string;
      plan?: string;
      admin?: AdminInput;
      admins?: AdminInput[];
    },
  ) {
    const db = this.client();
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
      throw new BadRequestException("slug must be 2–40 chars, [a-z0-9-]");
    }
    const plan = input.plan && isPlan(input.plan) ? input.plan : DEFAULT_PLAN;

    // Normalise to a list; default each admin's role to school_admin.
    const rawAdmins = input.admins ?? (input.admin ? [input.admin] : []);
    if (rawAdmins.length === 0) throw new BadRequestException("at least one admin is required");
    const admins = rawAdmins.map((a) => ({ ...a, role: a.role ?? "school_admin" }));
    for (const a of admins) {
      if (!ADMIN_ROLES.has(a.role)) throw new BadRequestException(`admin role ${a.role} not allowed`);
    }
    // A school must have at least one school_admin to own day-to-day administration.
    if (!admins.some((a) => a.role === "school_admin")) {
      throw new BadRequestException("at least one admin must be a school_admin");
    }
    // No duplicate emails within the batch, and none already in use globally.
    const emails = admins.map((a) => a.email.toLowerCase());
    if (new Set(emails).size !== emails.length) {
      throw new BadRequestException("duplicate admin email in the request");
    }
    if (await db.school.findFirst({ where: { slug } })) {
      throw new ConflictException("A school with that slug already exists");
    }
    if (await db.user.findFirst({ where: { email: { in: admins.map((a) => a.email) } } })) {
      throw new ConflictException("One of those admin emails is already in use");
    }

    // Resolve each role row up front (global registry; same for all schools).
    const prepared: Array<AdminInput & { role: string; roleId: string; tempPassword: string; passwordHash: string }> = [];
    for (const a of admins) {
      const roleRow = await db.role.findFirst({ where: { name: a.role } });
      if (!roleRow) throw new BadRequestException(`role ${a.role} is not seeded`);
      const tempPassword = a.password ?? this.genPassword();
      prepared.push({ ...a, role: a.role, roleId: roleRow.id, tempPassword, passwordHash: await bcrypt.hash(tempPassword, 10) });
    }

    const result = await db.$transaction(async (tx) => {
      const school = await tx.school.create({ data: { name: input.name, slug } });
      await tx.schoolSubscription.create({ data: { schoolId: school.id, plan, status: "ACTIVE" } });
      const created: Array<{ id: string; email: string; role: string; tempPassword: string }> = [];
      for (const a of prepared) {
        const u = await tx.user.create({
          data: { schoolId: school.id, email: a.email, name: a.name, passwordHash: a.passwordHash },
        });
        await tx.userRole.create({ data: { schoolId: school.id, userId: u.id, roleId: a.roleId } });
        created.push({ id: u.id, email: a.email, role: a.role, tempPassword: a.tempPassword });
      }
      return { school, created };
    });

    await this.auditInOperatorTenant(p, "operator.school.provision", "school", result.school.id, {
      slug,
      plan,
      admins: result.created.map((a) => ({ email: a.email, role: a.role })),
    });
    return {
      school: { id: result.school.id, name: result.school.name, slug: result.school.slug, plan },
      admins: result.created,
    };
  }

  /** Add another admin user to an EXISTING school. Returns one-time creds. */
  async createAdmin(p: Principal, schoolId: string, input: AdminInput) {
    const db = this.client();
    const role = input.role ?? "school_admin";
    if (!ADMIN_ROLES.has(role)) throw new BadRequestException("admin role not allowed");

    const school = await db.school.findFirst({ where: { id: schoolId } });
    if (!school) throw new NotFoundException("School not found");
    if (await db.user.findFirst({ where: { email: input.email } })) {
      throw new ConflictException("That email is already in use");
    }
    const roleRow = await db.role.findFirst({ where: { name: role } });
    if (!roleRow) throw new BadRequestException(`role ${role} is not seeded`);

    const tempPassword = input.password ?? this.genPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const admin = await db.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { schoolId, email: input.email, name: input.name, passwordHash },
      });
      await tx.userRole.create({ data: { schoolId, userId: u.id, roleId: roleRow.id } });
      return u;
    });

    await this.auditInOperatorTenant(p, "operator.school.admin.create", "user", admin.id, {
      targetSchoolId: schoolId,
      email: input.email,
      role,
    });
    return { id: admin.id, email: input.email, role, tempPassword };
  }

  // --- public onboarding-request review (global table; privileged client) -----
  /** List prospective-school onboarding requests (super_admin review queue). */
  async listOnboardingRequests(_p: Principal) {
    const db = this.client();
    return db.onboardingRequest.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  }

  /** Mark an onboarding request REVIEWING / APPROVED / REJECTED (audited). */
  async setOnboardingRequestStatus(
    p: Principal,
    id: string,
    status: "NEW" | "REVIEWING" | "APPROVED" | "REJECTED",
    note?: string,
  ) {
    const db = this.client();
    const existing = await db.onboardingRequest.findFirst({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException("Onboarding request not found");
    const updated = await db.onboardingRequest.update({
      where: { id },
      data: { status, reviewedById: p.userId, reviewNote: note ?? null },
    });
    await this.auditInOperatorTenant(p, "operator.onboarding.review", "onboarding_request", id, { status });
    return updated;
  }

  /** Audit lands in the OPERATOR's own tenant (the actor FK is the operator). */
  private async auditInOperatorTenant(
    p: Principal,
    action: string,
    entity: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record({ actorId: p.userId, action, entity, entityId, schoolId: p.schoolId, metadata }, tx),
    );
  }
}
