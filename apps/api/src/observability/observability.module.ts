import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import { LoggerModule } from "nestjs-pino";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MetricsService } from "./metrics.service";
import { MetricsController } from "./metrics.controller";
import { MetricsMiddleware } from "./metrics.middleware";
import { ErrorLoggingInterceptor } from "./error-logging.interceptor";

interface PrincipalReq extends IncomingMessage {
  principal?: { schoolId?: string; userId?: string };
}

// Observability spine:
//   - nestjs-pino: one structured JSON log per request (auto), with a request id,
//     the tenant/user from the verified JWT, redacted auth headers, and the query
//     string stripped from the URL (no `?token=` ever logged).
//   - prom-client /metrics (MetricsController + MetricsMiddleware, applied in
//     AppModule), incl. default Node.js process/GC/event-loop metrics.
//   - a global error interceptor that captures 5xx to Sentry (when SENTRY_DSN is
//     set) and logs with context, without altering responses.
// @Global so MetricsService + the pino logger are injectable everywhere.
@Global()
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        // Correlate across the BFF / CloudFront if it forwarded an id, else mint one.
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const existing = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
          res.setHeader("x-request-id", existing);
          return existing;
        },
        // The principal is attached by the guard; available by the time we log (res finish).
        customProps: (req: IncomingMessage) => {
          const p = (req as PrincipalReq).principal;
          return { school_id: p?.schoolId, user_id: p?.userId };
        },
        // SECURITY: never log credentials. Strip auth/cookie/step-up/webhook-sig headers.
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            'req.headers["x-stepup"]',
            'req.headers["x-paystack-signature"]',
            'req.headers["x-metrics-token"]',
          ],
          remove: true,
        },
        serializers: {
          // Strip the query string so a `?token=` is never logged; trim noise.
          req: (req: { id: unknown; method: string; url?: string }) => ({
            id: req.id,
            method: req.method,
            url: (req.url ?? "").split("?")[0],
          }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
        customSuccessMessage: () => "http_request",
        customErrorMessage: () => "http_request_error",
        // /metrics and /health are noisy + low-value to log on every scrape.
        autoLogging: {
          ignore: (req: IncomingMessage) => {
            const url = req.url ?? "";
            return url.startsWith("/metrics") || url.startsWith("/health");
          },
        },
      },
    }),
  ],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MetricsMiddleware,
    { provide: APP_INTERCEPTOR, useClass: ErrorLoggingInterceptor },
  ],
  exports: [MetricsService, MetricsMiddleware],
})
export class ObservabilityModule {}
