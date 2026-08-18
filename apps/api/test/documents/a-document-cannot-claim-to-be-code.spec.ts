// =============================================================================
// A stored file may not choose what it is served as
// =============================================================================
// The vault records the content type supplied at upload — `z.string().max(120)`,
// so any string — and the download replayed it. On its own that was survivable,
// because the download also sets `Content-Disposition: attachment`, which makes
// a browser save the file instead of rendering it.
//
// It stopped being survivable at the proxy. The web BFF rebuilt the response
// headers on two branches and attached the disposition to only one of them: the
// BINARY branch. A file declared `text/html` came back through the TEXT branch,
// so the browser received `Content-Type: text/html` and no disposition, from
// the application's own origin, and ran it with the reader's session. There is
// no CSP behind it.
//
// Demonstrated end to end before the fix, with a real login and a real upload:
//   API   ->  Content-Type: text/html; charset=utf-8
//             Content-Disposition: attachment; filename="probe.html"
//   BROWSER ->  Content-Type: text/html; charset=utf-8
//               (no disposition)
//               <script>alert(document.domain)</script>
//
// Both halves are fixed, deliberately: the proxy forwards the disposition on
// every branch, AND the file is no longer served as whatever it claims to be.
// One of those alone would have left the property depending on a hop that has
// already been wrong once.
//
// The same missing header had a quieter cost: every CSV export (`text/csv` also
// matches "text") opened in a tab instead of saving under its filename.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeDownloadType, safeFilename, DEFAULT_DOWNLOAD_TYPE } from "../../src/documents/safe-content-type";
import { DocumentsController } from "../../src/documents/documents.controller";

describe("what a stored file may be served as", () => {
  it("refuses to serve an uploaded file as HTML", () => {
    expect(safeDownloadType("text/html")).toBe(DEFAULT_DOWNLOAD_TYPE);
    expect(safeDownloadType("text/html; charset=utf-8")).toBe(DEFAULT_DOWNLOAD_TYPE);
    expect(safeDownloadType("application/xhtml+xml")).toBe(DEFAULT_DOWNLOAD_TYPE);
  });

  it("refuses SVG, which is scriptable however harmless it looks", () => {
    expect(safeDownloadType("image/svg+xml")).toBe(DEFAULT_DOWNLOAD_TYPE);
  });

  it("cannot be slipped past with case or parameters", () => {
    expect(safeDownloadType("TEXT/HTML")).toBe(DEFAULT_DOWNLOAD_TYPE);
    expect(safeDownloadType("  text/html ; charset=utf-8")).toBe(DEFAULT_DOWNLOAD_TYPE);
    // A parameter must not make an allowed type unrecognisable either.
    expect(safeDownloadType("application/pdf; qs=0.9")).toBe("application/pdf");
  });

  it("still serves the ordinary things a school uploads", () => {
    for (const t of ["application/pdf", "image/png", "image/jpeg", "text/csv", "text/plain"]) {
      expect(safeDownloadType(t)).toBe(t);
    }
  });

  it("falls back rather than failing when the type is missing or nonsense", () => {
    expect(safeDownloadType(null)).toBe(DEFAULT_DOWNLOAD_TYPE);
    expect(safeDownloadType("")).toBe(DEFAULT_DOWNLOAD_TYPE);
    expect(safeDownloadType("not-a-type")).toBe(DEFAULT_DOWNLOAD_TYPE);
  });
});

describe("the filename in the header", () => {
  it("strips what would break the header rather than throwing", () => {
    // Node throws on a header value containing a newline, so a document titled
    // with one turned its own download into a 500.
    expect(safeFilename('re\r\nport"s.pdf')).toBe("reports.pdf");
  });

  it("always yields something", () => {
    expect(safeFilename("")).toBe("download");
    expect(safeFilename('"""')).toBe("download");
  });

  it("is bounded", () => {
    expect(safeFilename("a".repeat(500)).length).toBe(150);
  });
});

describe("the download endpoint itself", () => {
  // The helper being correct proves nothing about the response. Reverting the
  // controller to echo the stored type left every other test in this file green,
  // which is exactly the gap this closes: assert the header that is sent.
  function download(storedType: string) {
    const headers: Record<string, string> = {};
    const controller = new DocumentsController({
      streamFile: async () => ({ buffer: Buffer.from("<script>alert(1)</script>"), filename: "probe.html", contentType: storedType }),
    } as never);
    const res = { set: (h: Record<string, string>) => Object.assign(headers, h) } as never;
    return controller.file({ userId: "u", schoolId: "s", roles: [], permissions: [] } as never, "doc-1", res).then(() => headers);
  }

  it("does not serve an uploaded file as the HTML it claims to be", async () => {
    const headers = await download("text/html");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("always tells the browser to save it", async () => {
    const headers = await download("text/html");
    expect(headers["Content-Disposition"]).toBe('attachment; filename="probe.html"');
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("leaves an ordinary PDF alone", async () => {
    const headers = await download("application/pdf");
    expect(headers["Content-Type"]).toBe("application/pdf");
  });
});

describe("the proxy that stands between the browser and the API", () => {
  // COMMENTS STRIPPED FIRST. Asserting over raw source matches the prose
  // explaining the fix, which is how a source test comes to pass because of the
  // note describing what it checks.
  const BFF = readFileSync(join(__dirname, "../../../web/app/api/sms/[...path]/route.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("forwards Content-Disposition on ONE path, not per branch", () => {
    // The regression was structural: two response constructions, and only one
    // carried the header. There must be a single header object both use.
    expect(BFF.match(/Content-Disposition/g) ?? []).toHaveLength(1);
    // Neither branch may build its own headers from the content type alone.
    expect(BFF).not.toMatch(/headers:\s*\{\s*"Content-Type":\s*ct\s*\}/);
  });

  it("sets nosniff on the response the browser actually sees", () => {
    expect(BFF).toMatch(/X-Content-Type-Options/);
  });

  it("still distinguishes text from binary bodies", () => {
    // The branch itself was never the bug — text must still be read as text, or
    // every PDF arrives corrupted.
    expect(BFF).toMatch(/ct\.includes\("json"\)/);
    expect(BFF).toMatch(/res\.arrayBuffer\(\)/);
  });
});
