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

  /** Create a school + its subscription + a first admin user. Returns one-time creds. */
  async provisionSchool(
    p: Principal,
    input: { name: string; slug: string; plan?: string; admin: AdminInput },
  ) {
    const db = this.client();
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
      throw new BadRequestException("slug must be 2–40 chars, [a-z0-9-]");
    }
    const plan = input.plan && isPlan(input.plan) ? input.plan : DEFAULT_PLAN;
    const role = input.admin.role ?? "school_admin";
    if (!ADMIN_ROLES.has(role)) throw new BadRequestException("admin role not allowed");

    if (await db.school.findFirst({ where: { slug } })) {
      throw new ConflictException("A school with that slug already exists");
    }
    if (await db.user.findFirst({ where: { email: input.admin.email } })) {
      throw new ConflictException("That admin email is already in use");
    }
    const roleRow = await db.role.findFirst({ where: { name: role } });
    if (!roleRow) throw new BadRequestException(`role ${role} is not seeded`);

    const tempPassword = input.admin.password ?? this.genPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const result = await db.$transaction(async (tx) => {
      const school = await tx.school.create({ data: { name: input.name, slug } });
      await tx.schoolSubscription.create({ data: { schoolId: school.id, plan, status: "ACTIVE" } });
      const admin = await tx.user.create({
        data: { schoolId: school.id, email: input.admin.email, name: input.admin.name, passwordHash },
      });
      await tx.userRole.create({ data: { schoolId: school.id, userId: admin.id, roleId: roleRow.id } });
      return { school, admin };
    });

    await this.auditInOperatorTenant(p, "operator.school.provision", "school", result.school.id, {
      slug,
      plan,
      adminEmail: input.admin.email,
      role,
    });
    return {
      school: { id: result.school.id, name: result.school.name, slug: result.school.slug, plan },
      admin: { id: result.admin.id, email: input.admin.email, role, tempPassword },
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
