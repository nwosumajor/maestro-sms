// Caller identity derived from the verified Auth.js JWT. Mirrors the Principal
// contract the integrity module depends on (integrity.foundation.ts).
export interface Principal {
  userId: string;
  schoolId: string;
  roles: string[];
  permissions: string[];
  /** Set ONLY on an impersonation token (`imp.by`): the operator acting through
   *  this identity. The principal itself is genuinely the target — same tenant,
   *  roles and RLS — so this is what keeps the audit trail honest about who
   *  actually did it (Golden Rule #5). Never grants anything. */
  impersonatedBy?: string;
  /**
   * The subset of `permissions` that came from an ACTIVE elevation grant rather
   * than the JWT. The guard merges grants into `permissions` so every service
   * that re-checks them agrees with the gate; this says which ones were lent, so
   * a service can record that an action was taken under cover. Never grants
   * anything by itself.
   */
  elevated?: string[];
}
