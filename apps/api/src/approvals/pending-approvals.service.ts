// =============================================================================
// PendingApprovalsService — the one inbox of everything waiting on this person
// =============================================================================
// A DISCOVERY layer only. Each module keeps ownership of its own maker-checker
// decision (permissions, separation of duties, step-up, in-tx side effects);
// this service just asks every source "what is pending that THIS caller could
// act on?" and returns a single list that deep-links back to the owning module.
// Nothing here approves anything, so no module's invariants are duplicated.
//
// Two rules are mirrored faithfully from each source, because getting them wrong
// would surface work the caller cannot actually do:
//   1. PERMISSION — a source is queried ONLY if the caller holds the permission
//      its decide endpoint requires (the SearchService pattern).
//   2. SEPARATION OF DUTIES — rows the caller themselves requested are excluded,
//      exactly as each module's decide path refuses requester == approver.
//
// Everything runs inside ONE tenant transaction (so RLS scopes every read), each
// source is capped, and requester names are resolved in a SINGLE batched query
// rather than per row.
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
import type { PendingApprovalDto } from "@sms/types";
import {
  ADMISSION_PERMISSIONS,
  APPROVAL_SOURCE_CAP,
  FEES_PERMISSIONS,
  HR_PERMISSIONS,
  PRIVACY_PERMISSIONS,
  SECURITY_PERMISSIONS,
} from "@sms/types";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

/** Shape every source normalises into before name resolution. */
interface RawItem {
  id: string;
  source: string;
  label: string;
  amountMinor: number | null;
  href: string;
  inline: boolean;
  createdAt: Date;
  /** Resolved to a display name in one batched pass. */
  requesterId: string | null;
  /** Extra context appended after the requester, e.g. "JSS2 · March". */
  context?: string;
}

const CAP = APPROVAL_SOURCE_CAP;

@Injectable()
export class PendingApprovalsService {
  constructor(@Inject(TENANT_DATABASE) private readonly db: TenantDatabase) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private has(p: Principal, perm: string): boolean {
    return p.permissions.includes(perm);
  }

  /**
   * Everything pending the caller's decision, newest first. Sources the caller
   * has no permission for are never queried at all.
   */
  async listPending(p: Principal): Promise<PendingApprovalDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const sources: Promise<RawItem[]>[] = [];

      // --- Fees: adjustments + payments/refunds awaiting a second pair of eyes
      if (this.has(p, FEES_PERMISSIONS.FEE_APPROVE)) {
        sources.push(this.feeAdjustments(tx, p), this.feePayments(tx, p));
      }
      // --- Security: privilege elevation (separation of duties is the point)
      if (this.has(p, SECURITY_PERMISSIONS.ELEVATION_APPROVE)) {
        sources.push(this.elevations(tx, p));
      }
      // --- HR money/lifecycle: all gated by hr.salary.approve
      if (this.has(p, HR_PERMISSIONS.HR_SALARY_APPROVE)) {
        sources.push(this.salaryChanges(tx, p), this.staffLoans(tx, p), this.staffExits(tx, p), this.employmentChanges(tx, p));
      }
      // --- Payroll: a run must be finalized by someone other than its creator
      if (this.has(p, HR_PERMISSIONS.HR_PAYROLL_RUN)) {
        sources.push(this.payrollRuns(tx, p));
      }
      // --- Admissions + NDPR erasure
      if (this.has(p, ADMISSION_PERMISSIONS.ADMISSION_REVIEW)) sources.push(this.admissions(tx));
      if (this.has(p, PRIVACY_PERMISSIONS.ERASURE_REVIEW)) sources.push(this.erasures(tx, p));

      const raw = (await Promise.all(sources)).flat();
      if (raw.length === 0) return [];

      // Resolve every requester name in ONE query (never per row).
      const ids = [...new Set(raw.map((r) => r.requesterId).filter((x): x is string => !!x))];
      const users = ids.length ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
      const nameOf = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));

      return raw
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((r) => {
          const who = r.requesterId ? nameOf.get(r.requesterId) ?? "Unknown" : null;
          const parts = [who ? `requested by ${who}` : null, r.context ?? null].filter(Boolean);
          return {
            id: r.id,
            source: r.source,
            label: r.label,
            detail: parts.join(" · "),
            amountMinor: r.amountMinor,
            href: r.href,
            inline: r.inline,
            createdAt: r.createdAt,
          };
        });
    });
  }

  // --- per-source queries ----------------------------------------------------
  // Each: pending state + NOT self-requested (separation of duties) + capped.

  private async feeAdjustments(tx: TenantTx, p: Principal): Promise<RawItem[]> {
    const rows = await tx.invoiceAdjustment.findMany({
      where: { status: "PENDING", requestedById: { not: p.userId } },
      orderBy: { createdAt: "desc" },
      take: CAP,
      select: { id: true, kind: true, amountMinor: true, reason: true, requestedById: true, createdAt: true, invoiceId: true },
    });
    return rows.map((r) => ({
      id: r.id,
      source: "FEE_ADJUSTMENT",
      label: `${r.kind === "WAIVER" ? "Waiver" : "Discount"} — ${r.reason}`,
      amountMinor: r.amountMinor,
      href: `/fees/invoices/${r.invoiceId}`,
      inline: false,
      createdAt: r.createdAt,
      requesterId: r.requestedById,
    }));
  }

  private async feePayments(tx: TenantTx, p: Principal): Promise<RawItem[]> {
    const rows = await tx.payment.findMany({
      where: { status: "PENDING_APPROVAL", recordedById: { not: p.userId } },
      orderBy: { paidAt: "desc" },
      take: CAP,
      select: { id: true, kind: true, amountMinor: true, recordedById: true, paidAt: true, invoiceId: true },
    });
    return rows.map((r) => ({
      id: r.id,
      source: "FEE_PAYMENT",
      label: r.kind === "REFUND" ? "Refund awaiting approval" : "Large payment awaiting approval",
      amountMinor: r.amountMinor,
      href: `/fees/invoices/${r.invoiceId}`,
      inline: false,
      createdAt: r.paidAt,
      requesterId: r.recordedById,
    }));
  }

  private async elevations(tx: TenantTx, p: Principal): Promise<RawItem[]> {
    const rows = await tx.privilegeGrant.findMany({
      where: { status: "PENDING", requestedById: { not: p.userId } },
      orderBy: { createdAt: "desc" },
      take: CAP,
      select: { id: true, permission: true, reason: true, requestedById: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      source: "ELEVATION",
      label: `Elevation — ${r.permission}`,
      amountMinor: null,
      href: "/admin/security",
      inline: false,
      createdAt: r.createdAt,
      requesterId: r.requestedById,
      context: r.reason,
    }));
  }

  private async salaryChanges(tx: TenantTx, p: Principal): Promise<RawItem[]> {
    const rows = await tx.salaryChangeRequest.findMany({
      where: { status: "PENDING", requestedById: { not: p.userId } },
      orderBy: { createdAt: "desc" },
      take: CAP,
      select: { id: true, employeeId: true, reason: true, requestedById: true, createdAt: true },
    });
    // NOTE: salary amounts are field-encrypted and deliberately NOT decrypted
    // here — the inbox is a pointer, the figure belongs on the HR page behind
    // its own step-up.
    return rows.map((r) => ({
      id: r.id,
      source: "SALARY_CHANGE",
      label: "Salary change awaiting approval",
      amountMinor: null,
      href: "/hr",
      inline: false,
      createdAt: r.createdAt,
      requesterId: r.requestedById,
      context: r.reason ?? undefined,
    }));
  }

  private async staffLoans(tx: TenantTx, p: Principal): Promise<RawItem[]> {
    const rows = await tx.staffLoan.findMany({
      where: { status: "PENDING", requestedById: { not: p.userId } },
      orderBy: { createdAt: "desc" },
      take: CAP,
      select: { id: true, purpose: true, requestedById: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      source: "STAFF_LOAN",
      label: `Staff loan — ${r.purpose}`,
      amountMinor: null, // principal is field-encrypted; shown on /hr
      href: "/hr",
      inline: false,
      createdAt: r.createdAt,
      requesterId: r.requestedById,
    }));
  }

  private async staffExits(tx: TenantTx, p: Principal): Promise<RawItem[]> {
    const rows = await tx.staffExit.findMany({
      where: { status: "PENDING", initiatedById: { not: p.userId } },
      orderBy: { createdAt: "desc" },
      take: CAP,
      select: { id: true, type: true, lastWorkingDay: true, initiatedById: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      source: "STAFF_EXIT",
      label: `Staff exit (${r.type})`,
      amountMinor: null, // final settlement is field-encrypted; shown on /hr
      href: "/hr",
      inline: false,
      createdAt: r.createdAt,
      requesterId: r.initiatedById,
      context: `last day ${r.lastWorkingDay.toISOString().slice(0, 10)}`,
    }));
  }

  private async employmentChanges(tx: TenantTx, p: Principal): Promise<RawItem[]> {
    const rows = await tx.employmentChangeRequest.findMany({
      where: { status: "PENDING", requestedById: { not: p.userId } },
      orderBy: { createdAt: "desc" },
      take: CAP,
      select: { id: true, type: true, requestedById: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      source: "EMPLOYMENT_CHANGE",
      label: `Employment change — ${r.type}`,
      amountMinor: null,
      href: "/hr",
      inline: false,
      createdAt: r.createdAt,
      requesterId: r.requestedById,
    }));
  }

  private async payrollRuns(tx: TenantTx, p: Principal): Promise<RawItem[]> {
    const rows = await tx.payrollRun.findMany({
      where: { status: "DRAFT", runById: { not: p.userId } },
      orderBy: { createdAt: "desc" },
      take: CAP,
      select: { id: true, periodYear: true, periodMonth: true, runType: true, totalNetMinor: true, runById: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      source: "PAYROLL_RUN",
      label: `Payroll run — ${String(r.periodMonth).padStart(2, "0")}/${r.periodYear}`,
      amountMinor: r.totalNetMinor,
      href: "/hr/payroll",
      inline: false,
      createdAt: r.createdAt,
      requesterId: r.runById,
      context: r.runType,
    }));
  }

  private async admissions(tx: TenantTx): Promise<RawItem[]> {
    // No separation-of-duties here: applications come from the PUBLIC intake,
    // so there is no internal requester to exclude.
    const rows = await tx.admissionApplication.findMany({
      where: { status: { in: ["NEW", "REVIEWING"] } },
      orderBy: { createdAt: "desc" },
      take: CAP,
      select: { id: true, applicantName: true, status: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      source: "ADMISSION",
      label: `Admission — ${r.applicantName}`,
      amountMinor: null,
      href: "/admin/admissions",
      inline: false,
      createdAt: r.createdAt,
      requesterId: null,
      context: r.status === "NEW" ? "new application" : "under review",
    }));
  }

  private async erasures(tx: TenantTx, p: Principal): Promise<RawItem[]> {
    const rows = await tx.erasureRequest.findMany({
      where: { status: "PENDING", requestedById: { not: p.userId } },
      orderBy: { createdAt: "desc" },
      take: CAP,
      select: { id: true, reason: true, requestedById: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      source: "ERASURE",
      label: "Data erasure request",
      amountMinor: null,
      href: "/admin/privacy",
      inline: false,
      createdAt: r.createdAt,
      requesterId: r.requestedById,
      context: r.reason,
    }));
  }
}
