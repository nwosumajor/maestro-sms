// =============================================================================
// HrService — staff employment records (salary encrypted at rest)
// =============================================================================
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { decryptField, encryptField } from "../foundation/field-crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

export interface EmployeeInput {
  jobTitle: string;
  department?: string | null;
  employmentType?: "FULL_TIME" | "PART_TIME" | "CONTRACT";
  startDate: string;
  endDate?: string | null;
  salaryMinor?: number | null;
  status?: string;
}

@Injectable()
export class HrService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async listEmployees(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const employees = await tx.employee.findMany({ orderBy: { createdAt: "desc" } });
      const ids = employees.map((e) => e.userId);
      const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
      const byId = new Map(users.map((u) => [u.id, u]));
      return employees.map((e) => ({
        ...this.decorate(e, p.schoolId),
        user: byId.get(e.userId) ?? null,
      }));
    });
  }

  async getEmployee(p: Principal, userId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const e = await tx.employee.findFirst({ where: { userId } });
      if (!e) throw new NotFoundException("Employee not found");
      await this.audit.record(
        { actorId: p.userId, action: "hr.employee.read", entity: "employee", entityId: e.id, schoolId: p.schoolId },
        tx,
      );
      return this.decorate(e, p.schoolId);
    });
  }

  async upsertEmployee(p: Principal, userId: string, input: EmployeeInput) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId }, select: { id: true } });
      if (!user) throw new NotFoundException("User not found");
      const salaryEnc =
        input.salaryMinor === undefined || input.salaryMinor === null
          ? null
          : encryptField(String(input.salaryMinor), p.schoolId);
      const data = {
        jobTitle: input.jobTitle,
        department: input.department ?? null,
        employmentType: input.employmentType ?? "FULL_TIME",
        startDate: new Date(input.startDate),
        endDate: input.endDate ? new Date(input.endDate) : null,
        salaryEnc,
        status: input.status ?? "ACTIVE",
      };
      const e = await tx.employee.upsert({
        where: { userId },
        update: data,
        create: { schoolId: p.schoolId, userId, ...data },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.employee.upsert", entity: "employee", entityId: e.id, schoolId: p.schoolId, metadata: { userId } },
        tx,
      );
      return this.decorate(e, p.schoolId);
    });
  }

  /** Replace the encrypted salary with a decrypted numeric for the reader. */
  private decorate<T extends { salaryEnc: string | null }>(e: T, schoolId: string) {
    const { salaryEnc, ...rest } = e;
    const dec = salaryEnc ? decryptField(salaryEnc, schoolId) : null;
    return { ...rest, salaryMinor: dec ? Number(dec) : null };
  }
}
