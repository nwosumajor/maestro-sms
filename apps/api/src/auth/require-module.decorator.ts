import { SetMetadata } from "@nestjs/common";
import type { ModuleKey } from "@sms/types";

export const MODULE_KEY = "sms:required_module";

/**
 * Gate a controller/route on a subscription MODULE (e.g. "fees"). Enforced by
 * PermissionGuard: if the caller's school plan doesn't include the module the
 * route returns 404 (never-leak), regardless of role permission. Orthogonal to
 * @RequirePermission — a route can require BOTH. Untagged routes are never
 * module-gated (foundation/security/privacy/notifications stay always-on).
 */
export const RequireModule = (module: ModuleKey) => SetMetadata(MODULE_KEY, module);
