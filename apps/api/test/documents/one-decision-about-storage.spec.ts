// =============================================================================
// Nine copies of "is this s3?", and a fail-open default underneath them
// =============================================================================
// `process.env.STORAGE_PROVIDER === "s3"` was written out longhand in NINE
// places — eight module bindings and the conditional registration of the
// development upload controller. They agreed, and nothing made them agree.
//
// Drift there is not cosmetic. One disagreeing copy sends a module's files to a
// different store than its metadata assumes; and since the ninth copy decides
// whether `LocalStorageController` is registered, a disagreement mounts an
// UNAUTHENTICATED WRITE ENDPOINT in production.
//
// Underneath sat a fail-open default. Anything that was not exactly "s3" chose
// the STUB, so `STORAGE_PROVIDER=S3`, a trailing space, or a future `r2` would
// have written every upload to the container's own disk: works in testing,
// survives no redeploy, and is gone by the time a family asks for the document.
// Nothing would have said so.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertStorageProviderConfigured, usingS3 } from "../../src/documents/storage-provider.config";

const SRC = join(__dirname, "../../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".ts")) out.push(f);
  }
  return out;
}

describe("choosing the storage provider", () => {
  const original = process.env.STORAGE_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = original;
  });

  it("scanned something — this gate can otherwise pass by finding nothing", () => {
    // THE FAILURE EVERY SOURCE-SCANNING GATE SHARES. The check above asserts an
    // EMPTY offender list, so a walk that returns no files passes with a green
    // tick while covering nothing at all — a moved directory, a changed
    // extension, a renamed root. Demonstrated on this repo by pointing one
    // gate's walk at a directory holding no `.ts` files: every assertion still
    // passed. The magnitude is the only thing that can tell "clean" from "blind".
    expect(walk(SRC).length).toBeGreaterThan(100);
  });

  it("uses the stub when nothing is set, as the local default", () => {
    delete process.env.STORAGE_PROVIDER;
    expect(usingS3()).toBe(false);
    expect(() => assertStorageProviderConfigured()).not.toThrow();
  });

  it("recognises a real bucket", () => {
    process.env.STORAGE_PROVIDER = "s3";
    expect(usingS3()).toBe(true);
  });

  it("reads S3 and ' s3 ' as the same intent", () => {
    // Treating these as "not s3" is how uploads end up on a disposable disk.
    for (const v of ["S3", " s3 ", "S3 "]) {
      process.env.STORAGE_PROVIDER = v;
      expect([v, usingS3()]).toEqual([v, true]);
    }
  });

  it("REFUSES TO START on a provider nobody implemented", () => {
    // The fail-open default this replaces: an unknown value silently chose the
    // stub. A failed deploy is cheap; a term of documents on a container disk
    // is not.
    process.env.STORAGE_PROVIDER = "r2";
    expect(() => assertStorageProviderConfigured()).toThrow(/not a provider this platform has/);
  });

  it("names the value it refused, so the fix is obvious", () => {
    process.env.STORAGE_PROVIDER = "aws-s3";
    expect(() => assertStorageProviderConfigured()).toThrow(/aws-s3/);
  });
});

describe("the decision itself", () => {
  it("is made in exactly one place", () => {
    // The anti-drift rule this codebase applies wherever two callers must agree.
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith("storage-provider.config.ts"))
      .filter((f) => readFileSync(f, "utf8").includes("process.env.STORAGE_PROVIDER"))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it("is what decides whether the development upload route exists", () => {
    // LocalStorageController is an unauthenticated write endpoint. It must be
    // registered by the SAME decision that binds the stub, or the two can
    // disagree and it appears in production.
    const mod = readFileSync(join(SRC, "documents/documents.module.ts"), "utf8");
    expect(mod).toMatch(/usingS3\(\) \? \[\] : \[LocalStorageController\]/);
  });

  it("is asserted at boot, before anything is served", () => {
    const main = readFileSync(join(SRC, "main.ts"), "utf8");
    const assertAt = main.indexOf("assertStorageProviderConfigured()");
    const createAt = main.indexOf("NestFactory.create");
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(createAt);
  });
});
