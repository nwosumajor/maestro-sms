// =============================================================================
// A handled error logged as a crash
// =============================================================================
// The ErrorLoggingInterceptor runs BEFORE the global MalformedIdFilter and
// judged any non-HttpException a 500: logged at ERROR as "unhandled_exception"
// and captured to Sentry — while the filter then answered the caller correctly
// with 404 (malformed id), 409 (duplicate), 400 (unknown reference) or 503
// (busy pool). Found by a simulation that sent a malformed id: the response was
// right, and the log said the API had crashed. On a busy minute that was one
// Sentry event per refused request, burying the real faults.
// =============================================================================
import { Logger } from "@nestjs/common";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, throwError } from "rxjs";
import { Prisma } from "@sms/db";

jest.mock("@sentry/node", () => ({ withScope: jest.fn(), captureException: jest.fn() }));
import * as Sentry from "@sentry/node";
import { ErrorLoggingInterceptor } from "../../src/observability/error-logging.interceptor";

const ctx = {
  switchToHttp: () => ({ getRequest: () => ({ id: "r1", method: "GET", url: "/x", route: { path: "/x/:id" } }) }),
} as unknown as ExecutionContext;
const prismaError = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "5", meta: { message } });

async function logOf(err: unknown) {
  const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  const handler: CallHandler = { handle: () => throwError(() => err) };
  await expect(lastValueFrom(new ErrorLoggingInterceptor().intercept(ctx, handler))).rejects.toBe(err);
  const out = { error: error.mock.calls.length, warn: warn.mock.calls.map((c) => c[0] as { status: number }) };
  error.mockRestore();
  warn.mockRestore();
  return out;
}

describe("the error log tells a handled error from a crash", () => {
  const OLD = process.env.SENTRY_DSN;
  beforeAll(() => (process.env.SENTRY_DSN = "https://example.invalid/1"));
  afterAll(() => (process.env.SENTRY_DSN = OLD));
  afterEach(() => jest.clearAllMocks());

  it.each([
    ["a malformed id", "P2023", "Inconsistent column data: Error creating UUID, invalid character", 404],
    ["a duplicate", "P2002", "Unique constraint failed", 409],
    ["an unknown reference", "P2003", "Foreign key constraint failed", 400],
    ["a busy pool", "P2028", "Unable to start a transaction in the given time", 503],
  ])("%s is logged at WARN with its REAL status, never to Sentry", async (_n, code, msg, status) => {
    const out = await logOf(prismaError(code, msg));
    expect(out.error).toBe(0);
    expect(out.warn[0]).toMatchObject({ status });
    expect(Sentry.withScope).not.toHaveBeenCalled();
  });

  it("a real fault is still a loud 500 at ERROR, captured to Sentry", async () => {
    const out = await logOf(new Error("boom"));
    expect(out.error).toBe(1);
    expect(Sentry.withScope).toHaveBeenCalled();
  });

  it("so is a Prisma error the filter does NOT translate (corrupt data stays loud)", async () => {
    const out = await logOf(prismaError("P2023", "Inconsistent column data: something else entirely"));
    expect(out.error).toBe(1);
  });
});
