// Opens an AsyncLocalStorage store for every request so anything downstream (the
// PermissionGuard, once it has VERIFIED the token) can record who is really
// acting, and AuditLogService can read it. Middleware — not a guard/interceptor —
// because it wraps next(), which is what makes the store propagate through the
// whole async continuation.

import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { requestContext } from "./request-context";

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    // Mutable store: the guard fills in `impersonatedBy` after verifying the JWT.
    requestContext.run({}, () => next());
  }
}
