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
}
