// =============================================================================
// SalaryService — salary-change approval (maker-checker) + history
// =============================================================================
// A salary change is REQUESTED (maker) and must be APPROVED by a DIFFERENT person
// holding hr.salary.approve (checker) — separation of duties, mirroring the
// maker-checker on money in Fees. Only on approval is Employee.salaryEnc updated.
// Each salary_change_request row IS the immutable history (no hard delete).
// Old/new salaries are field-ENCRYPTED at rest; decrypted only for HR readers.
// Audit metadata never carries the plaintext salary (GR#5).
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SalaryChangeDto } from "@sms/types";
import { decryptField, encryptField } from "../foundation/field-crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

@Injectable()
export class SalaryService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Maker: request a salary change for an employee (no change applied yet). */
  async requestChange(
    p: Principal,
    employeeId: string,
    input: { newSalaryMinor: number; reason?: string | null; effectiveDate?: string | null },
  ): Promise<SalaryChangeDto> {
    if (input.newSalaryMinor < 0) throw new BadRequestException("salary must be >= 0");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const emp = await tx.employee.findFirst({ where: { id: employeeId } });
      if (!emp) throw new NotFoundException("Employee not found");
      const row = await tx.salaryChangeRequest.create({
        data: {
          schoolId: p.schoolId,
          employeeId,
          oldSalaryEnc: emp.salaryEnc,
          newSalaryEnc: encryptField(String(input.newSalaryMinor), p.schoolId),
          reason: input.reason ?? null,
          effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : null,
          status: "PENDING",
          requestedById: p.userId,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.salary.request", entity: "salary_change_request", entityId: row.id, schoolId: p.schoolId, metadata: { employeeId } },
        tx,
      );
      return this.decorate(row, p.schoolId, null);
    });
  }

  /** Checker: approve/reject a pending change. Must differ from the requester. */
  async decide(
    p: Principal,
    id: string,
    approve: boolean,
    reason?: string | null,
  ): Promise<SalaryChangeDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.salaryChangeRequest.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Salary change request not found");
      if (row.status !== "PENDING") throw new BadRequestException("Request is not pending");
      if (row.requestedById === p.userId) {
        throw new ForbiddenException("A salary change must be approved by a different person");
      }
      const status = approve ? "APPROVED" : "REJECTED";
      await tx.salaryChangeRequest.update({
        where: { id },
        data: { status, decidedById: p.userId, decidedAt: new Date(), reason: reason ?? row.reason },
      });
      if (approve) {
        // Apply the new salary to the employment record only now.
        await tx.employee.update({ where: { id: row.employeeId }, data: { salaryEnc: row.newSalaryEnc } });
      }
      await this.audit.record(
        { actorId: p.userId, action: approve ? "hr.salary.approve" : "hr.salary.reject", entity: "salary_change_request", entityId: id, schoolId: p.schoolId, metadata: { employeeId: row.employeeId } },
        tx,
      );
      const updated = { ...row, status, decidedById: p.userId, decidedAt: new Date() };
      return this.decorate(updated, p.schoolId, null);
    });
  }

  /** History for one employee (or all) — newest first. */
  async list(p: Principal, employeeId?: string): Promise<SalaryChangeDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.salaryChangeRequest.findMany({
        where: employeeId ? { employeeId } : {},
        orderBy: { createdAt: "desc" },
      });
      const empIds = [...new Set(rows.map((r) => r.employeeId))];
      const emps = await tx.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, userId: true } });
      const userIds = emps.map((e) => e.userId);
      const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
      const userByEmp = new Map(emps.map((e) => [e.id, users.find((u) => u.id === e.userId)?.name ?? null]));
      return rows.map((r) => this.decorate(r, p.schoolId, userByEmp.get(r.employeeId) ?? null));
    });
  }

  private decorate(
    r: { id: string; employeeId: string; oldSalaryEnc: string | null; newSalaryEnc: string | null; reason: string | null; effectiveDate: Date | null; status: string; requestedById: string; decidedById: string | null; decidedAt: Date | null; createdAt: Date },
    schoolId: string,
    employeeName: string | null,
  ): SalaryChangeDto {
    const dec = (v: string | null) => (v ? Number(decryptField(v, schoolId)) : null);
    return {
      id: r.id,
      employeeId: r.employeeId,
      employeeName,
      oldSalaryMinor: dec(r.oldSalaryEnc),
      newSalaryMinor: dec(r.newSalaryEnc),
      reason: r.reason,
      effectiveDate: r.effectiveDate,
      status: r.status,
      requestedById: r.requestedById,
      decidedById: r.decidedById,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    };
  }
}
