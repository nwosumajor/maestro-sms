// =============================================================================
// HrService — staff employment records (salary encrypted at rest)
// =============================================================================
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SelfProfileDto } from "@sms/types";
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

export interface SelfProfileInput {
  phone?: string | null;
  address?: string | null;
  nextOfKin?: string | null;
  nextOfKinPhone?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
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
      // GR#5: the list view DECRYPTS every salary, so the read must be audited
      // exactly like the single-record read. entityId scopes to the school.
      await this.audit.record(
        { actorId: p.userId, action: "hr.employee.list", entity: "employee", entityId: p.schoolId, schoolId: p.schoolId, metadata: { count: employees.length } },
        tx,
      );
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
      const existing = await tx.employee.findFirst({ where: { userId }, select: { id: true } });
      // Salary is set ONLY at create. Changing an existing employee's salary must
      // go through the maker-checker SalaryService (request → approve → history),
      // so upsert never silently moves pay. salaryMinor on an update is ignored.
      const initialSalaryEnc =
        input.salaryMinor === undefined || input.salaryMinor === null
          ? null
          : encryptField(String(input.salaryMinor), p.schoolId);
      const common = {
        jobTitle: input.jobTitle,
        department: input.department ?? null,
        employmentType: input.employmentType ?? "FULL_TIME",
        startDate: new Date(input.startDate),
        endDate: input.endDate ? new Date(input.endDate) : null,
        status: input.status ?? "ACTIVE",
      };
      const e = await tx.employee.upsert({
        where: { userId },
        update: common, // no salaryEnc — preserve it (changes go via approval)
        create: { schoolId: p.schoolId, userId, ...common, salaryEnc: initialSalaryEnc },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.employee.upsert", entity: "employee", entityId: e.id, schoolId: p.schoolId, metadata: { userId, created: !existing } },
        tx,
      );
      return this.decorate(e, p.schoolId);
    });
  }

  // --- self-service profile (the staff member's OWN record) ------------------
  /** The caller's own employee record with personal fields decrypted for them. */
  async getMyProfile(p: Principal): Promise<SelfProfileDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const e = await tx.employee.findFirst({ where: { userId: p.userId } });
      if (!e) throw new NotFoundException("No employee record — ask HR to create one");
      await this.audit.record(
        { actorId: p.userId, action: "hr.self.read", entity: "employee", entityId: e.id, schoolId: p.schoolId },
        tx,
      );
      return this.selfProfile(e, p.schoolId);
    });
  }

  /** Update ONLY the caller's own personal/bank fields (HR owns employment fields). */
  async updateMyProfile(p: Principal, input: SelfProfileInput): Promise<SelfProfileDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const e = await tx.employee.findFirst({ where: { userId: p.userId }, select: { id: true } });
      if (!e) throw new NotFoundException("No employee record — ask HR to create one");
      const enc = (v: string | null | undefined) =>
        v === undefined ? undefined : v === null || v === "" ? null : encryptField(v, p.schoolId);
      const updated = await tx.employee.update({
        where: { id: e.id },
        data: {
          phoneEnc: enc(input.phone),
          addressEnc: enc(input.address),
          nextOfKinEnc: enc(input.nextOfKin),
          nextOfKinPhoneEnc: enc(input.nextOfKinPhone),
          bankNameEnc: enc(input.bankName),
          bankAccountEnc: enc(input.bankAccount),
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.self.update", entity: "employee", entityId: e.id, schoolId: p.schoolId, metadata: { bankChanged: input.bankAccount !== undefined } },
        tx,
      );
      return this.selfProfile(updated, p.schoolId);
    });
  }

  // --- NDPR: staff data-subject rights (self-service) ------------------------
  /** Export ALL of the caller's own HR data as a JSON bundle (NDPR access right). */
  async exportMyData(p: Principal): Promise<Record<string, unknown>> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const e = await tx.employee.findFirst({ where: { userId: p.userId } });
      const profile = e ? this.selfProfile(e, p.schoolId) : null;
      const employment = e
        ? { jobTitle: e.jobTitle, department: e.department, employmentType: e.employmentType, startDate: e.startDate, status: e.status, salaryMinor: e.salaryEnc ? Number(decryptField(e.salaryEnc, p.schoolId)) : null }
        : null;
      const [leave, balances, appraisals, training, documents] = await Promise.all([
        tx.leaveRequest.findMany({ where: { userId: p.userId }, orderBy: { createdAt: "desc" } }),
        tx.leaveBalance.findMany({ where: { userId: p.userId } }),
        tx.appraisal.findMany({ where: { userId: p.userId, status: { in: ["SUBMITTED", "ACKNOWLEDGED"] } } }),
        tx.trainingRecord.findMany({ where: { userId: p.userId } }),
        tx.staffDocument.findMany({ where: { userId: p.userId }, select: { kind: true, name: true, expiresAt: true, createdAt: true } }),
      ]);
      const payslips = e
        ? (await tx.payslip.findMany({ where: { userId: p.userId } })).map((s) => ({
            grossMinor: s.grossEnc ? Number(decryptField(s.grossEnc, p.schoolId)) : null,
            netMinor: s.netEnc ? Number(decryptField(s.netEnc, p.schoolId)) : null,
          }))
        : [];
      await this.audit.record(
        { actorId: p.userId, action: "hr.self.export", entity: "user", entityId: p.userId, schoolId: p.schoolId },
        tx,
      );
      return { exportedAt: new Date().toISOString(), employment, profile, leave, balances, payslips, appraisals, training, documents };
    });
  }

  /** Erase the caller's own self-service personal/bank fields (NDPR erasure). The
   *  employment/payroll record itself is retained (statutory). */
  async eraseMyPersonal(p: Principal): Promise<{ erased: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const e = await tx.employee.findFirst({ where: { userId: p.userId }, select: { id: true } });
      if (!e) throw new NotFoundException("No employee record");
      await tx.employee.update({
        where: { id: e.id },
        data: { phoneEnc: null, addressEnc: null, nextOfKinEnc: null, nextOfKinPhoneEnc: null, bankNameEnc: null, bankAccountEnc: null },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.self.erase", entity: "employee", entityId: e.id, schoolId: p.schoolId },
        tx,
      );
      return { erased: true };
    });
  }

  private selfProfile(
    e: {
      jobTitle: string; department: string | null;
      phoneEnc: string | null; addressEnc: string | null;
      nextOfKinEnc: string | null; nextOfKinPhoneEnc: string | null;
      bankNameEnc: string | null; bankAccountEnc: string | null;
    },
    schoolId: string,
  ): SelfProfileDto {
    const dec = (v: string | null) => (v ? decryptField(v, schoolId) : null);
    return {
      jobTitle: e.jobTitle,
      department: e.department,
      phone: dec(e.phoneEnc),
      address: dec(e.addressEnc),
      nextOfKin: dec(e.nextOfKinEnc),
      nextOfKinPhone: dec(e.nextOfKinPhoneEnc),
      bankName: dec(e.bankNameEnc),
      bankAccount: dec(e.bankAccountEnc),
    };
  }

  /** Replace the encrypted salary with a decrypted numeric for the reader. */
  private decorate<T extends { salaryEnc: string | null }>(e: T, schoolId: string) {
    const { salaryEnc, ...rest } = e;
    const dec = salaryEnc ? decryptField(salaryEnc, schoolId) : null;
    return { ...rest, salaryMinor: dec ? Number(dec) : null };
  }
}
