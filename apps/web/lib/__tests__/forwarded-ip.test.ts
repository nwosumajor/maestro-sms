// =============================================================================
// The client's address has to actually reach the API
// =============================================================================
// The API rate-limits per IP. The browser never speaks to the API — it speaks to
// this web tier, and the proxies forwarded Authorization, x-stepup and
// Content-Type and nothing else. So every request in the world arrived at the
// API from the same peer, the web task, and shared ONE bucket.
//
// Proved against the running stack: six password-reset requests from six
// different client IPs returned 201 201 201 201 201 429. And on sign-in it is
// ten attempts a minute across every school before the eleventh person anywhere
// is turned away — an availability bug before a security one.
//
// This is a wiring test on purpose. `forwardedFor` being correct proves nothing
// if a proxy forgets to call it, and that is exactly the failure that happened.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forwardedFor } from "../forwarded";

describe("forwardedFor", () => {
  const withHeader = (v: string | null) => ({ headers: { get: () => v } });

  it("passes the received chain through verbatim", () => {
    // Verbatim, not trimmed to one value: nginx has already appended the real
    // peer, and the API reads the RIGHTMOST entry. Rewriting it here would risk
    // handing the API a caller-supplied value as if it were trustworthy.
    expect(forwardedFor(withHeader("9.9.9.9, 203.0.113.7"))).toEqual({
      "x-forwarded-for": "9.9.9.9, 203.0.113.7",
    });
  });

  it("sends nothing when there is nothing to send", () => {
    // An empty header would be worse than none — the API would key every
    // request on the same blank value.
    expect(forwardedFor(withHeader(null))).toEqual({});
  });

  it("tolerates a missing request object", () => {
    expect(forwardedFor(undefined)).toEqual({});
  });
});

describe("every path to the API forwards it", () => {
  const root = join(__dirname, "../..");
  const paths: Array<[string, string]> = [
    ["the public proxy — unauthenticated intake", "app/api/public/[...path]/route.ts"],
    ["the session BFF", "app/api/sms/[...path]/route.ts"],
    ["sign-in, where the brute-force backstop lives", "lib/auth.ts"],
  ];

  it.each(paths)("%s forwards the client address", (_label, rel) => {
    const src = readFileSync(join(root, rel), "utf8");
    expect(src).toMatch(/forwardedFor\(/);
  });
});
