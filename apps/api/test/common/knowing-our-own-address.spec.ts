// =============================================================================
// Twelve places that guessed where this deployment lives
// =============================================================================
// `process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"` appeared TWELVE times:
// Paystack and Stripe return URLs, the billing and message-credit checkout
// callbacks, invite links, password-reset links, the admissions documents link,
// and the URL the TWILIO SIGNATURE is verified against.
//
// Each fails the same way when the variable is missing, and none says so. In
// production: payers returned to localhost so verify-on-return never fires,
// invite and reset links emailed to real people pointing at their own machine,
// and a Twilio signature computed over the wrong URL — which never matches, so
// credit refunds stop silently.
//
// Every symptom appears somewhere this deployment cannot see: a payer's browser,
// somebody else's inbox, a webhook that quietly stops matching. That is why an
// unset value is a boot failure in production rather than a warning nobody
// receives.
//
// Two services already refused to guess — mobile-money and admissions return
// EMPTY and warn rather than send half a URL. They were right; the twelve were
// guessing. // GOTCHA: they were not even guessing consistently with the stack
// around them — the code assumed `http://localhost:3000` (the Next dev server)
// while docker-compose sets `http://localhost` (nginx).
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertPublicWebUrlConfigured, publicWebUrl } from "../../src/common/public-url";

const SRC = join(__dirname, "../../src");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".ts")) out.push(f);
  }
  return out;
}

describe("resolving the public address", () => {
  const original = process.env.PUBLIC_WEB_URL;
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.PUBLIC_WEB_URL = original;
    process.env.NODE_ENV = originalEnv;
  });

  it("uses what is configured", () => {
    process.env.PUBLIC_WEB_URL = "https://school.example";
    expect(publicWebUrl()).toBe("https://school.example");
  });

  it("drops a trailing slash, so callbacks do not become double-slashed", () => {
    // Every caller appends a path. `https://x//billing?verify=…` is a different
    // URL to a gateway comparing return addresses, and to Twilio's signature.
    process.env.PUBLIC_WEB_URL = "https://school.example/";
    expect(publicWebUrl()).toBe("https://school.example");
  });

  it("REFUSES to start in production when it is unset", () => {
    process.env.NODE_ENV = "production";
    delete process.env.PUBLIC_WEB_URL;
    expect(() => assertPublicWebUrlConfigured()).toThrow(/Refusing to start/);
  });

  it("treats whitespace as unset", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_WEB_URL = "   ";
    expect(() => assertPublicWebUrlConfigured()).toThrow();
  });

  it("names what breaks, since none of it breaks visibly here", () => {
    process.env.NODE_ENV = "production";
    delete process.env.PUBLIC_WEB_URL;
    expect(() => assertPublicWebUrlConfigured()).toThrow(/Twilio signature check/);
  });

  it("still starts outside production on the default", () => {
    process.env.NODE_ENV = "test";
    delete process.env.PUBLIC_WEB_URL;
    expect(() => assertPublicWebUrlConfigured()).not.toThrow();
    expect(publicWebUrl()).toMatch(/^http:\/\/localhost/);
  });
});

describe("the decision itself", () => {
  it("is made in exactly one place", () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith("common/public-url.ts"))
      .filter((f) => /PUBLIC_WEB_URL \?\? "http/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it("leaves the two services that deliberately refuse to guess", () => {
    // They return EMPTY and warn rather than send half a URL — a rail with no
    // callback address, and a family with no documents link. Those are the right
    // answers for their cases and are not replaced by a default.
    for (const f of ["payments/mobile-money.service.ts", "admissions/admissions.service.ts"]) {
      expect([f, readFileSync(join(SRC, f), "utf8").includes("PUBLIC_WEB_URL is not set")]).toEqual([f, true]);
    }
  });

  it("is asserted at boot, with its siblings", () => {
    const main = readFileSync(join(SRC, "main.ts"), "utf8");
    for (const a of [
      "assertStorageProviderConfigured()",
      "assertFieldCryptoConfigured()",
      "assertAuthSecretUsable()",
      "assertPublicWebUrlConfigured()",
    ]) {
      expect([a, main.indexOf(a)]).not.toEqual([a, -1]);
      expect(main.indexOf(a)).toBeLessThan(main.indexOf("NestFactory.create"));
    }
  });
});
