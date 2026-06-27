import "reflect-metadata";
import type { Server as HttpServer } from "node:http";
import * as Sentry from "@sentry/node";
import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { GameSocketGateway } from "./game-socket/game-socket.gateway";

async function bootstrap() {
  // Error tracking: only active when a DSN is configured (no-op otherwise). The
  // ErrorLoggingInterceptor captures 5xx with request/tenant context.
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV ?? "production",
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
      release: process.env.APP_RELEASE,
    });
  }

  // rawBody: true preserves the exact bytes so the Paystack webhook HMAC
  // signature can be verified (re-serialising JSON would not match). bufferLogs so
  // early framework logs flush through pino once the logger is resolved.
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });
  const logger = app.get(PinoLogger);
  app.useLogger(logger); // route ALL Nest logs through pino (structured)
  app.enableShutdownHooks(); // so the game socket gateway tears down cleanly

  // CORS for the Next.js web app (credentials carry the Auth.js session cookie).
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  });
  // NOTE: validation is done per-route with Zod (ZodValidationPipe), so we do
  // NOT install a global class-validator ValidationPipe.

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);

  // Attach the live game WebSocket gateway to the same http server (it claims
  // only /ws/* upgrades). Identity comes from the same Auth.js JWT the API trusts.
  app.get(GameSocketGateway).attach(app.getHttpServer() as HttpServer);

  logger.log(`API listening on :${port} (game sockets at /ws/*)`);
}

void bootstrap();
