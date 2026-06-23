// =============================================================================
// Foundation contracts (interfaces only — implemented by the existing slice)
// =============================================================================
// We depend on the foundation's tenant-scoped DB runner, audit log, and consent
// service by CONTRACT, so this module compiles and tests in isolation and so we
// never reach around the foundation's security model. Wire the real providers in
// the module. Do NOT reimplement these here.
// =============================================================================

/** Whatever Prisma-ish surface the modules need inside a tenant tx. Typed as
 *  `any` so this module doesn't depend on the generated Prisma client. */
export interface TenantTx {
  assessment: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- reason: foundation Prisma types live in packages/db
  submission: any; // reason: see above
  submissionDraft: any; // reason: see above
  submissionTelemetry: any; // reason: see above
  integritySignal: any; // reason: see above
  studentIntegrityExemption: any; // reason: see above
  integrityRetentionRun: any; // reason: see above (app role: read-only history)
  // SIS tables
  studentProfile: any; // reason: see above
  emergencyContact: any; // reason: see above
  medicalRecord: any; // reason: see above
  // Attendance tables
  attendanceSession: any; // reason: see above
  attendanceRecord: any; // reason: see above
  // Notifications tables
  notification: any; // reason: see above
  notificationDelivery: any; // reason: see above
  // Fees / Billing tables
  feeItem: any; // reason: see above
  invoice: any; // reason: see above
  invoiceLineItem: any; // reason: see above
  payment: any; // reason: see above
  // Document Vault
  document: any; // reason: see above
  // Timetabling
  period: any; // reason: see above
  room: any; // reason: see above
  timetableEntry: any; // reason: see above
  // Security
  privilegeGrant: any; // reason: see above
  // Privacy
  erasureRequest: any; // reason: see above
  // Messaging + Calendar
  messageThread: any; // reason: see above
  threadParticipant: any; // reason: see above
  message: any; // reason: see above
  schoolEvent: any; // reason: see above
  // HR
  employee: any; // reason: see above
  // Admissions
  admissionApplication: any; // reason: see above
  // foundation tables
  user: any; // reason: see above
  userRole: any; // reason: see above
  role: any; // reason: see above (global/RLS-exempt; readable for staff pickers)
  auditLog: any; // reason: see above
  integrityConsent: any; // reason: see above
  school: any; // reason: see above (global/RLS-exempt, but reachable on the client)
  // LMS tables
  class: any; // reason: see above
  classTeacher: any; // reason: see above
  enrollment: any; // reason: see above
  parentChild: any; // reason: see above
  // Gradebook
  grade: any; // reason: see above
  // Approval workflow
  workflowRequest: any; // reason: see above
  workflowAuditLog: any; // reason: see above
}

export interface TenantContext {
  schoolId: string;
  userId: string;
}

/**
 * Richer caller identity from the verified JWT — used where relationship scoping
 * beyond a permission is required (e.g. "a teacher sees only their own classes",
 * RBAC model). roles/permissions come from the foundation guard, never the body.
 */
export interface Principal extends TenantContext {
  roles: string[];
  permissions: string[];
}

/**
 * Runs `fn` inside a DB transaction that has already executed
 *   SET LOCAL app.current_school_id = <schoolId>
 *   SET LOCAL app.current_user_id   = <userId>
 * so every statement is subject to RLS. This is the ONLY way this module
 * touches the DB — including in the BullMQ worker, which has no HTTP request and
 * MUST still set tenant context. // SECURITY: never expose a non-tenant client.
 */
export interface TenantDatabase {
  runAsTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export interface AuditEntry {
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  schoolId: string;
  metadata?: Record<string, unknown>;
}

/** Foundation audit log. Every integrity read/write goes through here (GR#5). */
export interface AuditLogService {
  record(entry: AuditEntry, tx?: TenantTx): Promise<void>;
}

/** Foundation NDPR consent. Gate ALL minor telemetry on this (GR#5). Reads the
 *  consent table inside the caller's active tenant transaction (RLS-scoped). */
export interface ConsentService {
  hasIntegrityConsent(
    args: { studentId: string; schoolId: string },
    tx: TenantTx,
  ): Promise<boolean>;
}

export const TENANT_DATABASE = Symbol("TENANT_DATABASE");
export const AUDIT_LOG_SERVICE = Symbol("AUDIT_LOG_SERVICE");
