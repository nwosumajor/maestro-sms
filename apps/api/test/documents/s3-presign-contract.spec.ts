// =============================================================================
// What the S3 presigner actually produces
// =============================================================================
// The production storage path cannot be exercised here: there is no bucket and
// no credentials. But SIGNING is local arithmetic — the SDK will sign a URL for
// a made-up key with made-up credentials perfectly happily — so the URL itself
// can be inspected, which is the same method the payment rails use against their
// providers' published contracts.
//
// WHAT THAT ESTABLISHED, and it is the reason this file exists:
//
// A presigned PUT signs ONLY `host`. Not the Content-Type. So the BROWSER
// decides what type an uploaded object is stored as, and S3 will later serve it
// back with that type — a file uploaded as `text/html` becomes a page on the
// bucket's own domain, script and all. The download presign used to attach a
// disposition only when a filename happened to be supplied, which left the
// protection depending on the caller remembering to pass one.
//
// AND IT FOUND ONE THAT WOULD HAVE BROKEN EVERY PRODUCTION UPLOAD. Since
// v3.729 the SDK computes a CRC32 for PutObject and, when presigning, puts it in
// the QUERY STRING — where it forms part of the signature. Presigning has no
// body, so the value is the checksum of nothing; S3 validates the file the
// browser actually sends against it and refuses. The signature is valid, the URL
// looks right, and the upload always fails.
//
// A first pass at this checked X-Amz-SignedHeaders, saw only `host`, and
// concluded there was no problem. The header was never where it lived.
// =============================================================================

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const credentials = { accessKeyId: "AKIAPROBE", secretAccessKey: "probe-secret" };
// The client built EXACTLY as the provider builds it, so these assertions are
// about the shipped configuration rather than a convenient one.
const client = new S3Client({ region: "eu-west-1", credentials, requestChecksumCalculation: "WHEN_REQUIRED" });
/** The same client WITHOUT the setting — what shipped before, kept so the
 *  defect itself is demonstrated rather than described. */
const unfixed = new S3Client({ region: "eu-west-1", credentials });

const q = (url: string, name: string) => new URL(url).searchParams.get(name);

describe("the presigned upload the browser is handed", () => {
  it("signs only the host, so no header the browser omits can break it", async () => {
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: "b", Key: "schools/s/submissions/x", ContentType: "application/pdf" }),
      { expiresIn: 900 },
    );
    expect(q(url, "X-Amz-SignedHeaders")).toBe("host");
  });

  it("carries NO checksum of an empty body — the defect that broke every upload", async () => {
    // The SDK computes a CRC32 for PutObject and, when presigning, puts it in
    // the QUERY STRING, where it is signed. Presigning has no body, so the value
    // is the checksum of nothing; S3 then validates the file the browser really
    // sends against it and refuses. The signature is perfectly valid — the
    // upload simply always fails.
    const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: "b", Key: "k" }), { expiresIn: 900 });
    expect(q(url, "x-amz-checksum-crc32")).toBeNull();
    expect(q(url, "x-amz-sdk-checksum-algorithm")).toBeNull();
  });

  it("and the defect is real — without the setting, the empty checksum is there", async () => {
    // Kept so this file demonstrates the bug rather than merely asserting the
    // fix. AAAAAA== is the CRC32 of zero bytes.
    const url = await getSignedUrl(unfixed, new PutObjectCommand({ Bucket: "b", Key: "k" }), { expiresIn: 900 });
    expect(q(url, "x-amz-checksum-crc32")).toBe("AAAAAA==");
  });

  it("expires, and within the quarter-hour the provider asks for", async () => {
    const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: "b", Key: "k" }), { expiresIn: 900 });
    expect(q(url, "X-Amz-Expires")).toBe("900");
  });

  it("does NOT bind the content type — which is why downloads must override it", async () => {
    // The finding this whole file turns on. The type is passed to the command
    // and does not end up in the signature, so the browser's own header is what
    // S3 stores.
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: "b", Key: "k", ContentType: "application/pdf" }),
      { expiresIn: 900 },
    );
    expect(q(url, "X-Amz-SignedHeaders")).not.toContain("content-type");
  });
});

describe("the presigned download", () => {
  // The provider's own construction, mirrored — a signed response override is
  // the only way to control what S3 sends back, since the stored type cannot be
  // trusted.
  const download = (opts: { filename?: string; inline?: boolean }) =>
    getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: "b",
        Key: "k",
        ...(opts.inline
          ? { ResponseContentDisposition: "inline" }
          : {
              ResponseContentDisposition: `attachment; filename="${opts.filename ?? "download"}"`,
              ResponseContentType: "application/octet-stream",
            }),
      }),
      { expiresIn: 900 },
    );

  it("forces attachment AND a byte stream, even with no filename to hand", async () => {
    // Previously neither was set unless a filename was supplied, so a document
    // stored as text/html came back as a renderable page.
    const url = await download({});
    expect(q(url, "response-content-disposition")).toBe('attachment; filename="download"');
    expect(q(url, "response-content-type")).toBe("application/octet-stream");
  });

  it("carries the filename when there is one", async () => {
    const url = await download({ filename: "birth-cert.pdf" });
    expect(q(url, "response-content-disposition")).toContain("birth-cert.pdf");
  });

  it("serves inline ONLY when asked, and that is a different signature", async () => {
    // Inline is for objects the SERVER wrote with a type it validated — the
    // school logo. The override differs, so the two URLs are not
    // interchangeable.
    const inline = await download({ inline: true });
    const attached = await download({});
    expect(q(inline, "response-content-disposition")).toBe("inline");
    expect(q(inline, "X-Amz-Signature")).not.toBe(q(attached, "X-Amz-Signature"));
  });

  it("includes the response overrides in the SIGNATURE, not merely the query", async () => {
    // Otherwise a recipient could strip them and get the object back with its
    // stored type — which is exactly what is being prevented.
    const url = await download({ filename: "x.pdf" });
    const signed = q(url, "X-Amz-SignedHeaders");
    expect(signed).toBe("host");
    // The overrides are canonical query parameters, so altering one invalidates
    // the signature. Proven by changing it and re-signing: a different result.
    const other = await download({ filename: "y.pdf" });
    expect(q(url, "X-Amz-Signature")).not.toBe(q(other, "X-Amz-Signature"));
  });
});

describe("what the provider tells its callers", () => {
  const src = readSource();

  it("defaults to attachment rather than requiring the caller to ask", () => {
    expect(src).toMatch(/ResponseContentType: "application\/octet-stream"/);
  });

  it("configures the client so a presigned upload can actually succeed", () => {
    expect(src).toMatch(/requestChecksumCalculation: "WHEN_REQUIRED"/);
  });

  it("uses inline for the school logo and nothing a member of the public uploaded", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const branding = readFileSync(join(__dirname, "../../src/branding/branding.service.ts"), "utf8");
    expect(branding).toMatch(/inline: true/);
    for (const f of ["documents.service.ts", "supplied-documents.service.ts"]) {
      const s = readFileSync(join(__dirname, "../../src/documents", f), "utf8");
      expect(s).not.toMatch(/inline: true/);
    }
  });
});

function readSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- reason: sync read in a describe body
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- reason: as above
  const { join } = require("node:path") as typeof import("node:path");
  return readFileSync(join(__dirname, "../../src/documents/s3-storage.provider.ts"), "utf8");
}
