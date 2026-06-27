// =============================================================================
// ErrorLoggingInterceptor — structured error logging + Sentry capture
// =============================================================================
// Globally taps errors thrown by route handlers, captures 5xx to Sentry (when a
// SENTRY_DSN is configured) and logs them with request context via the Nest
// Logger (routed through pino), then RE-THROWS unchanged so Nest's default
// exception handling still produces the exact same response (preserving
// 404-not-403 + all status codes). It NEVER alters responses — only observes.
//
// Guard rejections (401/403 before the handler) don't reach interceptors; those
// are still captured by nestjs-pino's request log.
// =============================================================================

import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  type NestInterceptor,
} from "@nestjs/common";
import * as Sentry from "@sentry/node";
import type { Observable } from "rxjs";
import { throwError } from "rxjs";
import { catchError } from "rxjs/operators";
import type { Request } from "express";
import type { Principal } from "../auth/principal";

interface ObservedRequest extends Request {
  principal?: Principal;
  // `id` (the request id) is added to Request by pino-http's type augmentation.
}

@Injectable()
export class ErrorLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("Exceptions");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        const req = context.switchToHttp().getRequest<ObservedRequest>();
        const status = err instanceof HttpException ? err.getStatus() : 500;
        const fields = {
          request_id: req.id,
          method: req.method,
          route: (req.route?.path as string | undefined) ?? "unmatched",
          status,
          school_id: req.principal?.schoolId,
          user_id: req.principal?.userId,
        };
        if (status >= 500) {
          if (process.env.SENTRY_DSN) {
            Sentry.withScope((scope) => {
              scope.setTags({ route: fields.route, request_id: String(req.id ?? "") });
              scope.setContext("request", fields);
              if (req.principal?.schoolId) scope.setTag("school_id", req.principal.schoolId);
              Sentry.captureException(err);
            });
          }
          this.logger.error(
            { ...fields, msg: "unhandled_exception", stack: err instanceof Error ? err.stack : undefined },
            err instanceof Error ? err.stack : undefined,
          );
        } else {
          // 4xx are expected (validation, not-found, forbidden) — log without a stack.
          this.logger.warn({ ...fields, msg: "handled_exception" });
        }
        return throwError(() => err); // unchanged — response semantics preserved
      }),
    );
  }
}
