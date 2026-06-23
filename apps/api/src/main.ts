import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  // rawBody: true preserves the exact bytes so the Paystack webhook HMAC
  // signature can be verified (re-serialising JSON would not match).
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // CORS for the Next.js web app (credentials carry the Auth.js session cookie).
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  });
  // NOTE: validation is done per-route with Zod (ZodValidationPipe), so we do
  // NOT install a global class-validator ValidationPipe.

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  new Logger("Bootstrap").log(`API listening on :${port}`);
}

void bootstrap();
