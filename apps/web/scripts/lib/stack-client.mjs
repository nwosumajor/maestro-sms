// =============================================================================
// Driving the running stack over HTTP, the way a browser does
// =============================================================================
// Shared by `route-smoke.mjs` and the walkthroughs: ONE sign-in path through the
// real Auth.js credentials flow, ONE notion of a page that failed to render.
// It was a single script's private code; a second script copying it would be
// the second spelling of a rule this repo keeps finding drifted.
// =============================================================================

/**
 * Where the stack is. Defaults to the compose stack behind nginx on port 80 —
 * `http://localhost:3000` is the Next dev server, and defaulting to it made a
 * healthy compose stack read as "fetch failed" (see route-smoke's history).
 */
export const WEB = process.env.WEB_URL ?? "http://localhost";
export const PASSWORD = process.env.SMOKE_PASSWORD ?? "password123";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The API rate-limits POST /auth/login (10/min per IP). Each web login triggers
// exactly one such call, so testing >9 roles would trip it and silently under-
// cover. A token bucket keeps us under the limit; a retry covers the boundary.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_PER_WINDOW = 9;
const loginTimes = [];
async function pace() {
  const now = Date.now();
  while (loginTimes.length && now - loginTimes[0] > LOGIN_WINDOW_MS) loginTimes.shift();
  if (loginTimes.length >= LOGIN_MAX_PER_WINDOW) {
    const wait = LOGIN_WINDOW_MS - (now - loginTimes[0]) + 500;
    console.log(`  …pacing logins (rate limit): waiting ${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
    return pace();
  }
  loginTimes.push(Date.now());
}

/** A cookie-jar client signed in as one person. */
export function makeClient() {
  const jar = new Map();
  const header = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };
  return {
    async login(email) {
      // Two attempts: the second waits out the full rate-limit window in case
      // the bucket estimate drifted (other clients sharing the IP, clock skew).
      for (let attempt = 0; attempt < 2; attempt++) {
        await pace();
        jar.clear();
        let r = await fetch(`${WEB}/api/auth/csrf`, { headers: { cookie: header() } });
        store(r);
        const { csrfToken } = await r.json();
        r = await fetch(`${WEB}/api/auth/callback/credentials`, {
          method: "POST", redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded", cookie: header() },
          body: new URLSearchParams({ csrfToken, email, password: PASSWORD, redirect: "false", json: "true" }),
        });
        store(r);
        if ([...jar.keys()].some((k) => k.includes("session-token"))) return true;
        if (attempt === 0) { console.log(`  …retrying login for ${email} after the rate window`); await sleep(LOGIN_WINDOW_MS + 500); }
      }
      return false;
    },
    async get(path) {
      return fetch(`${WEB}${path}`, { headers: { cookie: header() }, redirect: "manual" });
    },
    /** Bytes of the Auth.js session cookie(s) — route-smoke's size guardrail reads this. */
    sessionCookieBytes() {
      let n = 0;
      for (const [k, v] of jar.entries()) if (k.includes("session-token")) n += k.length + v.length + 1;
      return n;
    },
    // Read JSON via the BFF proxy (same auth path the app uses).
    async api(path) {
      const r = await this.get(`/api/sms${path}`);
      if (r.status !== 200) return null;
      const t = await r.text();
      return t ? JSON.parse(t) : null;
    },
    /**
     * A write through the BFF, re-authenticating when the API asks — the same
     * password → short-lived token → `x-stepup` retry the web's `sendWithStepUp`
     * performs. Returns `{ status, body }` with the body parsed when it is JSON.
     */
    async send(method, path, body) {
      const go = (extra = {}) =>
        fetch(`${WEB}/api/sms${path}`, {
          method,
          headers: { cookie: header(), ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "manual",
        });
      const read = async (r) => {
        const t = await r.text();
        let parsed = t;
        try { parsed = t ? JSON.parse(t) : null; } catch { /* not JSON */ }
        return { status: r.status, body: parsed };
      };
      let r = await go();
      if (r.status !== 403) return read(r);
      const first = await read(r);
      if (!JSON.stringify(first.body ?? "").includes("STEPUP_REQUIRED")) return first;
      const su = await fetch(`${WEB}/api/sms/security/stepup`, {
        method: "POST",
        headers: { cookie: header(), "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      if (!su.ok) return read(su);
      const { token } = await su.json();
      r = await go({ "x-stepup": token });
      return read(r);
    },
  };
}

// --- did a page render? -----------------------------------------------------

export const ERROR_RE = /Application error|server-side exception|is not a function|Cannot read propert|TypeError|__NEXT_ERROR/i;

// A page that THROWS during SSR is served as a 200 carrying the error boundary,
// and that boundary is a CLIENT component — so none of the strings above appear
// in the HTML and the shell looks like an ordinary small page. What a throw does
// leave is a serialized digest in the flight stream. Next uses the same channel
// for ordinary CONTROL FLOW, so the digest VALUE is the signal, not its
// presence:
//   NEXT_NOT_FOUND               notFound()  — a missing record, correct
//   NEXT_REDIRECT;...            redirect()  — a permission gate firing, correct
//   NEXT_HTTP_ERROR_FALLBACK;404 the same, newer form
//   <numeric>                    an UNCAUGHT error — the error boundary
const DIGEST_RE = /E\{\\?"digest\\?":\\?"([^"\\]+)/g;
const CONTROL_FLOW = /^(NEXT_NOT_FOUND|NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK)/;

/** Digests that mean a real throw, ignoring Next's control-flow sentinels. */
export function errorDigests(html) {
  return [...html.matchAll(DIGEST_RE)].map((m) => m[1]).filter((d) => !CONTROL_FLOW.test(d));
}

export function classify(status, html) {
  if (status === 500) return "FAIL";
  if (status === 200 && ERROR_RE.test(html)) return "FAIL";
  if (status === 200 && errorDigests(html).length) return "FAIL";
  return "ok"; // 200-clean, 3xx redirect (perm/nav), 401/403/404 are all fine
}
