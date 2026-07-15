// =============================================================================
// Request context — carries WHO is really acting, for the audit log
// =============================================================================
// When the platform owner impersonates a user, the request's Principal IS the
// target (that's the point — same tenant, same roles, same RLS). Without extra
// context every audited action would be indistinguishable from the target doing
// it themselves: the trail would say "the parent downloaded this", not "the owner
// did, as the parent". Golden Rule #5 is actor attribution, so that is not good
// enough.
//
// AsyncLocalStorage rather than threading a parameter through hundreds of audit
// call sites: the middleware opens a store for the request, the PermissionGuard
// (the only thing that has VERIFIED the token) fills in the impersonator, and
// AuditLogService reads it. A caller cannot forget to pass it.
// =============================================================================

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** userId of the operator acting THROUGH this principal, when impersonating. */
  impersonatedBy?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** The impersonator for the in-flight request, if any. */
export function currentImpersonator(): string | undefined {
  return requestContext.getStore()?.impersonatedBy;
}
