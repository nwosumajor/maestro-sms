// Subscription / module-entitlement DTOs (platform billing layer).
// Managed by super_admin via the Operator Console; consumed by the web nav and
// the backend ModuleGuard. No PII — purely a school's plan + module posture.

import type { ModuleKey, ModuleOverrides, Plan } from "../modules";

/** A school's current subscription + its RESOLVED effective module set. */
export interface SubscriptionDto {
  schoolId: string;
  plan: Plan;
  overrides: ModuleOverrides;
  /** The effective enabled modules (tier bundle + overrides), catalog order. */
  modules: ModuleKey[];
}

/** Operator update: pick a tier and (optionally) per-school overrides. */
export interface SubscriptionUpdateDto {
  plan: Plan;
  overrides?: ModuleOverrides;
}
