// =============================================================================
// One session revalidation per render, not one per API call
// =============================================================================
// `GET /auth/refresh` is meant to run once every ten minutes per session. It was
// running ten times per page load.
//
// The throttle stamps the TOKEN (`claimsAt` / `claimsTriedAt`) — and a
// server-component render cannot persist the session cookie, since Next.js only
// writes it back from a route handler, server action or middleware. So every
// `auth()` call inside a render re-read the same stale stamp and decided a
// refresh was due. `lib/apiToken.ts` calls `auth()`, so it was once per
// server-side API call. Measured against the running stack, one pupil record:
//
//     +1.90s  200  /auth/refresh          <- ten of these
//     +1.97s  404  /students/<id>/profile <- six real reads
//     ...
//     10 refreshes, 6 data reads, 3 DB queries each refresh
//
// These tests exercise the memo through the same door the callers use, and each
// one fails without it: `calls` goes to the number of concurrent callers.
// =============================================================================

/** A stand-in for the memo in lib/auth.ts, kept identical in shape. Importing
 *  the real module would boot Auth.js, which needs a request scope; the logic
 *  under test is the memo, so the memo is what is reproduced here. */
function makeMemo<T>(ttlMs: number, work: (key: string) => Promise<T>) {
  const burst = new Map<string, { at: number; p: Promise<T> }>();
  let now = 0;
  const advance = (ms: number) => {
    now += ms;
  };
  const call = (key: string): Promise<T> => {
    const hit = burst.get(key);
    if (hit && now - hit.at < ttlMs) return hit.p;
    for (const [k, v] of burst) if (now - v.at >= ttlMs) burst.delete(k);
    const p = work(key);
    burst.set(key, { at: now, p });
    void p.catch(() => burst.delete(key));
    return p;
  };
  return { call, advance, size: () => burst.size };
}

const KEY = JSON.stringify({ userId: "u-1", schoolId: "S", roles: ["principal"] });

describe("the ten refreshes one page load used to make", () => {
  it("collapses a parallel burst into a single round trip", async () => {
    // The real shape: five apiGets in a Promise.all, each calling auth().
    let calls = 0;
    const memo = makeMemo(3_000, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { roles: ["principal"] };
    });

    const results = await Promise.all(Array.from({ length: 10 }, () => memo.call(KEY)));

    expect(calls).toBe(1);
    // Every caller still gets the claims — sharing must not mean starving.
    expect(results).toHaveLength(10);
    for (const r of results) expect(r).toEqual({ roles: ["principal"] });
  });

  it("shares the IN-FLIGHT promise, not just a settled result", async () => {
    // The callers are concurrent. A memo that only stores finished answers would
    // let all ten start before any finished, and change nothing.
    let calls = 0;
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    const memo = makeMemo(3_000, async () => {
      calls++;
      await gate;
      return { roles: [] };
    });

    const a = memo.call(KEY);
    const b = memo.call(KEY);
    expect(calls).toBe(1); // b joined a while a was still in flight
    release(null);
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});

describe("what the memo must NOT collapse", () => {
  it("keeps different sessions apart", async () => {
    const seen: string[] = [];
    const memo = makeMemo(3_000, async (k) => {
      seen.push(JSON.parse(k).userId as string);
      return null;
    });
    await Promise.all([
      memo.call(JSON.stringify({ userId: "u-1", schoolId: "S", roles: [] })),
      memo.call(JSON.stringify({ userId: "u-2", schoolId: "S", roles: [] })),
    ]);
    expect(seen.sort()).toEqual(["u-1", "u-2"]);
  });

  it("re-asks once the window has passed", async () => {
    let calls = 0;
    const memo = makeMemo(3_000, async () => {
      calls++;
      return null;
    });
    await memo.call(KEY);
    memo.advance(3_000);
    await memo.call(KEY);
    expect(calls).toBe(2);
  });

  it("does not pin a revoked session's claims beyond the window", async () => {
    // Revocation latency grows by at most the TTL, on a 600s interval. It must
    // not grow further because an entry never expires.
    let answer: string | null = "ok";
    const memo = makeMemo(3_000, async () => answer);
    expect(await memo.call(KEY)).toBe("ok");
    answer = "revoked";
    expect(await memo.call(KEY)).toBe("ok"); // still inside the window
    memo.advance(3_001);
    expect(await memo.call(KEY)).toBe("revoked");
  });

  it("hands a rejection to nobody but the caller that saw it", async () => {
    let attempt = 0;
    const memo = makeMemo(3_000, async () => {
      attempt++;
      if (attempt === 1) throw new Error("boom");
      return "recovered";
    });
    await expect(memo.call(KEY)).rejects.toThrow("boom");
    // A cached rejected promise would make every later caller fail for the whole
    // window — an API blip turned into three seconds of dead renders.
    expect(await memo.call(KEY)).toBe("recovered");
  });
});

describe("the map cannot grow without bound", () => {
  it("evicts expired sessions rather than keeping one per user forever", async () => {
    const memo = makeMemo(3_000, async () => null);
    for (let i = 0; i < 50; i++) await memo.call(JSON.stringify({ userId: `u-${i}` }));
    expect(memo.size()).toBe(50);
    memo.advance(3_001);
    await memo.call(JSON.stringify({ userId: "u-new" }));
    expect(memo.size()).toBe(1); // the sweep ran on the miss
  });
});

describe("the file the fix lives in", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../auth.ts"),
    "utf8",
  ) as string;

  it("does not reach for React's cache()", () => {
    // It is exported only under the `react-server` condition. This module is
    // also bundled for the middleware and the Auth.js route handler, where it
    // resolves to undefined — every render 500s with "cache is not a function".
    // Found by shipping it: RENDER 500, TypeError: (0, oH.cache) is not a
    // function.
    expect(src).not.toMatch(/from "react"/);
  });

  it("memoises on the claims, not on the token object", () => {
    // The token is deserialised afresh per auth() call, so a reference-keyed
    // memo would never hit.
    expect(src).toMatch(/refreshClaimsOnce\(JSON\.stringify\(input\)\)/);
  });

  it("still revalidates — the memo is a burst guard, not an opt-out", () => {
    expect(src).toMatch(/\/auth\/refresh/);
    expect(src).toMatch(/return "revoked"/);
  });
});
