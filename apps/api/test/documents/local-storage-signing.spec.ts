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
import { stripComments } from "../support/strip-comments";
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
  const src = stripComments(readFileSync(join(__dirname, "../../src/documents/local-storage.controller.ts"), "utf8"));
  // The write itself lives in the STUB PROVIDER, because streaming a body to
  // disk is the provider's job and the controller's only business is which
  // ceiling was signed for. Read both, or half the property is unguarded.
  const stubSrc = stripComments(readFileSync(join(__dirname, "../../src/documents/storage.provider.ts"), "utf8"));

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

  it("stops at the cap rather than buffering whatever is sent", () => {
    // Checking the size AFTER reading means the whole thing is already in
    // memory — which is the wrong moment to object to it.
    //
    // RE-ANCHORED TO THE PROPERTY. This used to pin the literal
    // `readBoundedBody(req, MAX_UPLOAD_BYTES)`, and went red on a change that
    // STRENGTHENED what it guards: the cap is now chosen per signed operation
    // (a document and a lesson recording are three orders of magnitude apart)
    // and the bytes stream to disk instead of into one Buffer. Both the old
    // spellings were gone and both properties were better. A fixed-text
    // assertion has failed this way repeatedly in this repo.
    //
    // The properties, stated as properties: a limit is passed in and it comes
    // from the op that verified, never a constant written at the call site.
    expect(src).toMatch(/uploadLimitOf\(op\)/);
    expect(src).not.toMatch(/MAX_UPLOAD_BYTES/); // a single hard-coded ceiling is the defect
    // And the refusal happens on the way past, not afterwards.
    expect(stubSrc).toMatch(/if \(size > limit\)/);
  });

  it("does not hold the whole upload in memory", () => {
    // A 10 MB document buffered fine; a 1.5 GB recording is an OOM. The stub
    // writes the stream out as it arrives and REMOVES a partial file when the
    // cap is passed — a half-written object that `exists()` would vouch for is
    // worse than none.
    expect(stubSrc).toMatch(/async uploadStream\(/);
    expect(stubSrc).toMatch(/await handle\.write\(chunk\)/);
    expect(stubSrc).toMatch(/fs\.rm\(file, \{ force: true \}\)/);
    // Not collected into an array and concatenated at the end.
    expect(stubSrc).not.toMatch(/Buffer\.concat\(chunks\)/);
  });

  it("reads the raw stream, because Express does not parse a PDF body", () => {
    // @Body() on an application/pdf PUT is empty, so the upload arrives as
    // nothing and the failure looks like an empty file rather than a bug.
    // The PROPERTY is that the request object itself is what is consumed.
    expect(src).toMatch(/uploadStream\(key, req,/);
  });

  it("refuses outright unless the stub provider is the one bound", () => {
    expect(src).toMatch(/instanceof StubStorageProvider/);
  });
});

describe("it is absent in production", () => {
  const moduleSrc = stripComments(readFileSync(join(__dirname, "../../src/documents/documents.module.ts"), "utf8"));

  it("is not registered when the real bucket is bound", () => {
    // Not "checked and refused" — NOT REGISTERED. A development convenience
    // must not be a production surface, and the surest way is for it not to
    // exist there at all.
    //
    // Asserted against the SHARED decision (`usingS3()`), not a copy of the
    // env comparison. There were nine such copies; this route's registration
    // was one of them, so a copy that drifted would have mounted an
    // unauthenticated write endpoint in production. See
    // documents/storage-provider.config.ts.
    expect(moduleSrc).toMatch(/usingS3\(\) \? \[\] : \[LocalStorageController\]/);
  });
});
