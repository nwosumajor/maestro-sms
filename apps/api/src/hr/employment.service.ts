// =============================================================================
// EmploymentService — confirmation / promotion / contract-renewal maker-checker
// =============================================================================
// Mirrors the salary-change precedent: hr.write REQUESTS a change; a DIFFERENT
// person holding hr.salary.approve DECIDES. On approval the change applies to
// the employee row in the same tx; each request row IS the append-only
// employment history. A PROMOTION never moves salary — pay goes through the
// salary maker-checker separately. Tenant-isolated (RLS); everything audited.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { EmploymentChangeDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

type ChangeRow = {
  id: string;
  userId: string;
  type: string;
  newJobTitle: string | null;
  newGradeLevel: string | null;
  newEndDate: Date | null;
  reason: string | null;
  status: string;
  requestedById: string;
  decidedById: string | null;
  decidedAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class EmploymentService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Maker: request a lifecycle change (nothing applies yet). */
  async request(
    p: Principal,
    input: {
      userId: string;
      type: "CONFIRMATION" | "PROMOTION" | "RENEWAL";
      newJobTitle?: string;
      newGradeLevel?: string;
      newEndDate?: string;
      reason?: string;
    },
  ): Promise<EmploymentChangeDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const emp = await tx.employee.findFirst({ where: { userId: input.userId } });
      if (!emp) throw new NotFoundException("Employee record not found");
      if (input.type === "CONFIRMATION" && emp.confirmationStatus !== "PROBATION") {
        throw new BadRequestException("This employee is not on probation");
      }
      if (input.type === "PROMOTION" && !(input.newJobTitle ?? "").trim() && !(input.newGradeLevel ?? "").trim()) {
        throw new BadRequestException("A promotion needs a new title and/or grade level");
      }
      let newEndDate: Date | null = null;
      if (input.type === "RENEWAL") {
        if (!input.newEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.newEndDate)) {
          throw new BadRequestException("A renewal needs the new contract end date (YYYY-MM-DD)");
        }
        newEndDate = new Date(`${input.newEndDate}T00:00:00.000Z`);
        if (emp.endDate && newEndDate <= emp.endDate) {
          throw new BadRequestException("The new end date must extend the current contract");
        }
      }
      const dup = await tx.employmentChangeRequest.findFirst({
        where: { userId: input.userId, type: input.type, status: "PENDING" },
        select: { id: true },
      });
      if (dup) throw new BadRequestException("An identical request is already awaiting a decision");
      const row = await tx.employmentChangeRequest.create({
        data: {
          schoolId: p.schoolId,
          userId: input.userId,
          type: input.type,
          newJobTitle: (input.newJobTitle ?? "").trim() || null,
          newGradeLevel: (input.newGradeLevel ?? "").trim() || null,
          newEndDate,
          reason: (input.reason ?? "").trim() || null,
          requestedById: p.userId,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.employment.request", entity: "employment_change_request", entityId: row.id, schoolId: p.schoolId, metadata: { userId: input.userId, type: input.type } },
        tx,
      );
      return this.toDto(row as ChangeRow, null);
    });
  }

  /** Checker: decide. Separation of duties — the requester can never decide.
   *  Approval APPLIES the change to the employee row in the same tx. */
  async decide(p: Principal, id: string, approve: boolean): Promise<EmploymentChangeDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = (await tx.employmentChangeRequest.findFirst({ where: { id } })) as ChangeRow | null;
      if (!row) throw new NotFoundException("Request not found");
      if (row.status !== "PENDING") throw new BadRequestException("This request has already been decided");
      if (row.requestedById === p.userId) {
        throw new ForbiddenException("An employment change must be decided by a different person");
      }
      if (approve) {
        const emp = await tx.employee.findFirst({ where: { userId: row.userId }, select: { id: true } });
        if (!emp) throw new NotFoundException("Employee record not found");
        await tx.employee.update({
          where: { id: emp.id },
          data:
            row.type === "CONFIRMATION"
              ? { confirmationStatus: "CONFIRMED", probationEndsAt: null }
              : row.type === "PROMOTION"
                ? {
                    ...(row.newJobTitle ? { jobTitle: row.newJobTitle } : {}),
                    ...(row.newGradeLevel ? { gradeLevel: row.newGradeLevel } : {}),
                  }
                : { endDate: row.newEndDate, contractReminderSentAt: null }, // RENEWAL re-arms the reminder
        });
      }
      const updated = await tx.employmentChangeRequest.update({
        where: { id },
        data: { status: approve ? "APPROVED" : "REJECTED", decidedById: p.userId, decidedAt: new Date() },
      });
      await this.audit.record(
        { actorId: p.userId, action: approve ? "hr.employment.approve" : "hr.employment.reject", entity: "employment_change_request", entityId: id, schoolId: p.schoolId, metadata: { userId: row.userId, type: row.type } },
        tx,
      );
      return this.toDto(updated as ChangeRow, null);
    });
  }

  /** History/queue: all requests, or one employee's (hr.read). */
  async list(p: Principal, userId?: string): Promise<EmploymentChangeDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = (await tx.employmentChangeRequest.findMany({
        where: userId ? { userId } : {},
        orderBy: { createdAt: "desc" },
        take: 200,
      })) as ChangeRow[];
      const users = await tx.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
        select: { id: true, name: true },
      });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      return rows.map((r) => this.toDto(r, nameById.get(r.userId) ?? null));
    });
  }

  private toDto(r: ChangeRow, userName: string | null): EmploymentChangeDto {
    return {
      id: r.id,
      userId: r.userId,
      userName,
      type: r.type as EmploymentChangeDto["type"],
      newJobTitle: r.newJobTitle,
      newGradeLevel: r.newGradeLevel,
      newEndDate: r.newEndDate,
      reason: r.reason,
      status: r.status as EmploymentChangeDto["status"],
      requestedById: r.requestedById,
      decidedById: r.decidedById,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    };
  }
}
