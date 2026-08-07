/**
 * apiGet — what returns null, and what throws.
 *
 * The distinction is the whole point: 349 call sites write `?? []` or `?? 0`,
 * so anything this function swallows becomes a confident statement of fact on
 * a page — "No disputes", "Nothing waiting on you", "Approvals 0". A reader
 * acts on those. So a broken server has to be loud, and a genuinely absent
 * record has to stay quiet.
 */

jest.mock("server-only", () => ({}));
jest.mock("@/lib/apiToken", () => ({ bearerForSession: jest.fn().mockResolvedValue("token") }));

import { apiGet } from "@/lib/api";
import { bearerForSession } from "@/lib/apiToken";

const respond = (status: number, body = "") =>
  jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, text: async () => body });

describe("apiGet returns null for an ANSWER", () => {
  it("404 — the record is not there", async () => {
    global.fetch = respond(404) as never;
    await expect(apiGet("/x")).resolves.toBeNull();
  });

  it("403 — half the app reads what the caller may not see, and expects null", async () => {
    // Briefly a throw. Measured against a real stack that broke 491 (page,role)
    // pairs across 52 of 102 routes, because pages rely on this returning null
    // rather than gating every call. It is logged instead.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = respond(403) as never;
    await expect(apiGet("/workflows")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("403 GET /workflows"));
    warn.mockRestore();
  });

  it("401 — the session is gone; middleware owns the redirect", async () => {
    global.fetch = respond(401) as never;
    await expect(apiGet("/x")).resolves.toBeNull();
  });

  it("200 with an EMPTY body — the case this function was written for", async () => {
    // A pupil with no medical record answers 200 and nothing; res.json() would
    // throw on that, which is why the body is read as text first.
    global.fetch = respond(200, "") as never;
    await expect(apiGet("/x")).resolves.toBeNull();
  });

  it("no session — nothing to fetch with", async () => {
    (bearerForSession as jest.Mock).mockResolvedValueOnce(null);
    global.fetch = respond(200, "{}") as never;
    await expect(apiGet("/x")).resolves.toBeNull();
  });
});

describe("apiGet THROWS when the server is broken", () => {
  it("500", async () => {
    global.fetch = respond(500) as never;
    await expect(apiGet("/fees/disputes")).rejects.toThrow(/API 500: GET \/fees\/disputes/);
  });

  it("502 and 503 too — every 5xx, not just 500", async () => {
    global.fetch = respond(502) as never;
    await expect(apiGet("/x")).rejects.toThrow(/API 502/);
    global.fetch = respond(503) as never;
    await expect(apiGet("/x")).rejects.toThrow(/API 503/);
  });

  it("429 — rate limited is not an answer about the data", async () => {
    // The per-tenant limiter allows 1,200 req/min per SCHOOL. A rejected read
    // used to render as "No invoices" — telling a busy school its ledger is
    // empty. It also silently hollowed out the route smoke, which was making
    // 19,286 rate-limited requests and counting the empty pages as passes.
    global.fetch = respond(429) as never;
    await expect(apiGet("/invoices")).rejects.toThrow(/API 429.*rate limited/s);
  });

  it("a network failure, naming the path so it can be traced", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed")) as never;
    await expect(apiGet("/workflows")).rejects.toThrow(/API unreachable: GET \/workflows/);
  });

  it("keeps the original error as `cause`", async () => {
    const cause = new TypeError("ECONNREFUSED");
    global.fetch = jest.fn().mockRejectedValue(cause) as never;
    await expect(apiGet("/x")).rejects.toMatchObject({ cause });
  });
});

describe("the happy path still works", () => {
  it("parses a 200 body", async () => {
    global.fetch = respond(200, '{"a":1}') as never;
    await expect(apiGet<{ a: number }>("/x")).resolves.toEqual({ a: 1 });
  });
});
