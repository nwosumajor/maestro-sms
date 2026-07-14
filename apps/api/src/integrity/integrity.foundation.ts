// =============================================================================
// Foundation contracts (interfaces only — implemented by the existing slice)
// =============================================================================
// We depend on the foundation's tenant-scoped DB runner, audit log, and consent
// service by CONTRACT, so this module compiles and tests in isolation and so we
// never reach around the foundation's security model. Wire the real providers in
// the module. Do NOT reimplement these here.
// =============================================================================

import type { Prisma } from "@sms/db";

// The tenant-scoped Prisma surface available inside a runAsTenant() transaction.
// This is EXACTLY the interactive-transaction client Prisma hands to
// `$transaction((tx) => …)` (see PrismaTenantService), so every `tx.<model>`
// call is fully typed against the generated schema. `import type` keeps this a
// compile-time-only dependency — no runtime coupling to the generated client.
// SECURITY: real types mean a service that stops producing a field, or reads a
// column that no longer exists, now fails the build instead of returning `any`.
export type TenantTx = Prisma.TransactionClient;

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
  /**
   * Like `runAsTenant`, but routed to the READ REPLICA (when `DATABASE_REPLICA_URL`
   * is configured) and marked READ ONLY. For aggregate/list/report endpoints that
   * never write — offloads read load from the primary writer at scale. The same
   * tenant GUC + RLS apply. Falls back to the primary when no replica is set, so
   * it is always safe to use for a read path. // SECURITY: still tenant-isolated.
   */
  runAsTenantReadOnly<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
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
