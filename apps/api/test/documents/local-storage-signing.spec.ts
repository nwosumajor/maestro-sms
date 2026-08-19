// =============================================================================
// The signature on a local presigned URL
// =============================================================================
// The stub storage provider hands the browser a URL pointing back at the API, so
// that the one path a family actually walks — browser straight to storage — can
// be exercised without a bucket. That makes it an UNAUTHENTICATED WRITE
// ENDPOINT, and the signature is the only thing standing in front of it.
//
// It exists for local and CI. With STORAGE_PROVIDER=s3 the route is not
// registered at all, which is a stronger guarantee than any check inside it.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signStorage, signStorageUrl } from "../../src/documents/local-storage-signing";

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-secret-for-storage-urls";
});

describe("what the signature covers", () => {
  it("binds the key, so one link cannot be pointed at another file", () => {
    const exp = 2_000_000_000;
    expect(signStorage("schools/a/submissions/one", "put", exp)).not.toBe(
      signStorage("schools/a/submissions/two", "put", exp),
    );
  });

  it("binds the OPERATION, so a read link cannot be replayed as a write", () => {
    // The one that matters most: a family's download link must not become a way
    // to overwrite what they sent.
    const exp = 2_000_000_000;
    expect(signStorage("schools/a/x", "get", exp)).not.toBe(signStorage("schools/a/x", "put", exp));
  });

  it("binds the EXPIRY, so a link cannot be extended by editing the query", () => {
    expect(signStorage("schools/a/x", "put", 1_000)).not.toBe(signStorage("schools/a/x", "put", 9_999));
  });

  it("is deterministic for the same three things", () => {
    expect(signStorage("schools/a/x", "put", 42)).toBe(signStorage("schools/a/x", "put", 42));
  });

  it("mints an expiry in the future", () => {
    const { exp } = signStorageUrl("schools/a/x", "put", 900);
    expect(exp * 1000).toBeGreaterThan(Date.now());
    expect(exp * 1000).toBeLessThan(Date.now() + 901_000);
  });
});

describe("the endpoint that honours it", () => {
  const src = readFileSync(join(__dirname, "../../src/documents/local-storage.controller.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("refuses a key that is not one this platform issues", () => {
    // Containment: nothing may climb out of the storage directory.
    expect(src).toMatch(/KEY_SHAPE\.test\(key\)/);
  });

  it("length-guards before timingSafeEqual, which throws on a mismatch", () => {
    // Unguarded, a short signature is a 500 rather than a refusal — the same
    // trap the gateway webhook checks document.
    expect(src).toMatch(/a\.length !== b\.length \|\| !crypto\.timingSafeEqual/);
  });

  it("checks the expiry", () => {
    expect(src).toMatch(/expNum \* 1000 < Date\.now\(\)/);
  });

  it("stops reading at the cap rather than buffering whatever is sent", () => {
    // Checking the size AFTER reading means the whole thing is already in
    // memory — which is the wrong moment to object to it.
    expect(src).toMatch(/readBoundedBody\(req, MAX_UPLOAD_BYTES\)/);
    expect(src).toMatch(/if \(size > limit\) return null;/);
  });

  it("reads the raw stream, because Express does not parse a PDF body", () => {
    // @Body() on an application/pdf PUT is empty, so the upload arrives as
    // nothing and the failure looks like an empty file rather than a bug.
    expect(src).toMatch(/for await \(const chunk of req\)/);
  });

  it("refuses outright unless the stub provider is the one bound", () => {
    expect(src).toMatch(/instanceof StubStorageProvider/);
  });
});

describe("it is absent in production", () => {
  const moduleSrc = readFileSync(join(__dirname, "../../src/documents/documents.module.ts"), "utf8");

  it("is not registered when the real bucket is bound", () => {
    // Not "checked and refused" — NOT REGISTERED. A development convenience
    // must not be a production surface, and the surest way is for it not to
    // exist there at all.
    expect(moduleSrc).toMatch(/STORAGE_PROVIDER === "s3" \? \[\] : \[LocalStorageController\]/);
  });
});
