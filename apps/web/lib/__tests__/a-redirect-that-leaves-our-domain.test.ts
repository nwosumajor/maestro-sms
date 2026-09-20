/**
 * AN OPEN REDIRECT ON THE SIGN-IN PAGE.
 *
 * `?next=` is the one redirect target a visitor controls. It was validated in
 * THREE places with the same hand-rolled pair — `startsWith("/") &&
 * !startsWith("//")` — which stops the obvious protocol-relative form and
 * misses the backslash family, because a browser normalises `\` to `/` before
 * resolving a URL.
 *
 * MEASURED against the running stack, signed in, reading `Location`:
 *
 *     next=//evil.example.com        -> /dashboard             blocked
 *     next=https://evil.example.com  -> /dashboard             blocked
 *     next=/\evil.example.com        -> /\evil.example.com     SENT
 *     next=/%5Cevil.example.com      -> /%5Cevil.example.com   SENT
 *     next=/\/evil.example.com       -> /\/evil.example.com    SENT
 *
 * The damage is phishing-shaped: a link to OUR real login URL that hands the
 * user to an attacker's page the instant they authenticate. The victim checks
 * the domain, sees ours, and is moved afterwards.
 *
 * The rule is now a destination allowlist rather than a prefix test, written
 * once. These are the vectors, not the implementation — a rewrite that still
 * refuses them all is free to happen.
 */
import { safeRedirect, isSafeRedirect, allowedRedirectHosts, DEFAULT_REDIRECT } from "@/lib/safe-redirect";

describe("a redirect that leaves our domain", () => {
  const OURS = "https://app.majormaestro.com";

  beforeEach(() => {
    process.env.PUBLIC_WEB_URL = OURS;
    delete process.env.REDIRECT_ALLOWED_HOSTS;
    delete process.env.NEXT_PUBLIC_WEB_URL;
  });

  describe("same-origin paths, which are the normal case", () => {
    for (const ok of [
      "/dashboard",
      "/classes/978eda11-db47-4cb7-b77f-404bdd99acb5/content",
      "/fees?status=OPEN&page=2",
      "/live-classes?classId=abc#top",
      "/a/b/c",
    ]) {
      it(`allows ${ok}`, () => expect(safeRedirect(ok)).toBe(ok));
    }
  });

  describe("every way of writing somewhere else", () => {
    const vectors: Array<[string, string]> = [
      ["protocol-relative", "//evil.example.com"],
      ["backslash, MEASURED LIVE", "/\\evil.example.com"],
      ["encoded backslash, MEASURED LIVE", "/%5Cevil.example.com"],
      ["backslash-slash, MEASURED LIVE", "/\\/evil.example.com"],
      ["double backslash", "\\\\evil.example.com"],
      ["encoded double slash", "/%2F%2Fevil.example.com"],
      ["absolute http", "http://evil.example.com/x"],
      ["absolute https", "https://evil.example.com/x"],
      ["scheme-only", "https:evil.example.com"],
      ["javascript", "javascript:alert(1)"],
      ["data url", "data:text/html,<script>alert(1)</script>"],
      ["tab-smuggled", "/\tevil.example.com"],
      ["newline-smuggled", "/\nevil.example.com"],
      ["carriage-return", "/\revil.example.com"],
      ["null byte", "/\u0000evil.example.com"],
      ["no leading slash", "evil.example.com"],
      ["userinfo trick", "https://app.majormaestro.com@evil.example.com/"],
      ["suffix lookalike", "https://notapp.majormaestro.com/x"],
      ["empty", ""],
      ["whitespace", "   "],
    ];
    for (const [name, bad] of vectors) {
      it(`refuses ${name}`, () => {
        expect(safeRedirect(bad)).toBe(DEFAULT_REDIRECT);
        expect(isSafeRedirect(bad)).toBe(false);
      });
    }

    it("refuses a non-string", () => {
      expect(safeRedirect(undefined)).toBe(DEFAULT_REDIRECT);
      expect(safeRedirect(null)).toBe(DEFAULT_REDIRECT);
    });
  });

  describe("the allowlist of OUR domains", () => {
    it("accepts an absolute URL on our own host", () => {
      expect(safeRedirect(`${OURS}/dashboard`)).toBe(`${OURS}/dashboard`);
    });

    it("accepts a second host named in REDIRECT_ALLOWED_HOSTS", () => {
      process.env.REDIRECT_ALLOWED_HOSTS = "portal.example.org, www.example.org";
      expect(safeRedirect("https://portal.example.org/x")).toBe("https://portal.example.org/x");
    });

    it("takes a bare host or a full URL in that variable", () => {
      process.env.REDIRECT_ALLOWED_HOSTS = "https://portal.example.org";
      expect(allowedRedirectHosts()).toContain("portal.example.org");
    });

    it("a wildcard covers subdomains and the root, NOT a suffix lookalike", () => {
      process.env.REDIRECT_ALLOWED_HOSTS = "*.example.org";
      expect(safeRedirect("https://a.example.org/x")).toBe("https://a.example.org/x");
      expect(safeRedirect("https://example.org/x")).toBe("https://example.org/x");
      // The reason a wildcard is not a bare `endsWith`: this host is a
      // different registration that merely ends with the same letters.
      expect(safeRedirect("https://notexample.org/x")).toBe(DEFAULT_REDIRECT);
      expect(safeRedirect("https://example.org.evil.com/x")).toBe(DEFAULT_REDIRECT);
    });

    it("ignores a malformed entry rather than widening the list", () => {
      process.env.REDIRECT_ALLOWED_HOSTS = "::::, ,";
      expect(safeRedirect("https://evil.example.com/x")).toBe(DEFAULT_REDIRECT);
    });

    it("refuses everything absolute when no host is configured", () => {
      // Fail CLOSED: a deployment that has not said what it owns owns nothing.
      delete process.env.PUBLIC_WEB_URL;
      expect(safeRedirect("https://anything.example.com/x")).toBe(DEFAULT_REDIRECT);
    });
  });

  it("honours a caller's own fallback", () => {
    expect(safeRedirect("//evil.example.com", "/login")).toBe("/login");
  });
});
