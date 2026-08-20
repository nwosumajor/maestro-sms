import { SetMetadata } from "@nestjs/common";

export const PERMISSION_KEY = "sms:required_permission";

/**
 * Gate a route on a fine-grained permission string (e.g. "integrity.report.read").
 * Enforced by PermissionGuard, backstopped by Postgres RLS at the data layer.
 *
 * Several permissions mean ANY ONE of them opens the route — for the handful of
 * endpoints one action reaches from genuinely different directions. The
 * scholarship stage decision is the case that forced it: a guardian and a class
 * supervisor arrive holding `scholarship.apply`, the school's final reviewer
 * holds `workflow.review.principal`, and it is one decision on one application.
 * Gating it on the applicant's permission alone meant the only way to let a
 * deputy stand in for an absent principal was to also make them an applicant.
 *
 * This is NOT a way to soften a gate. Each permission listed must be one that
 * would legitimately carry the route on its own; the service still narrows to
 * the caller's actual relationship to the row (404, never 403).
 */
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSION_KEY, permissions.length === 1 ? permissions[0] : permissions);
