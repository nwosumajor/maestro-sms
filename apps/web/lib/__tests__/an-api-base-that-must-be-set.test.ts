// =============================================================================
// A deployment that forgot where the API is must fail LOUDLY
// =============================================================================
// `process.env.API_BASE_URL ?? "http://localhost:3001"` was written out in
// sixteen files, and `??` is blind to an EMPTY STRING. So a mistyped secret
// name, a missing task-definition entry, or a deploy outside the Terraform that
// sets it would pass straight through, and the web tier would ask
// http://localhost:3001 from inside its own container.
//
// Nothing listens there. Every server-rendered page comes back BLANK, with no
// error naming the cause and nothing in the logs pointing at a variable — the
// exact "unrecoverable afterwards, so fail at boot" case the operational-safety
// rules already name for the encryption key, the auth secret and the storage
// provider.
//
// Production fails closed; local work keeps the localhost default, the same
// split `assertFieldCryptoConfigured` makes in the API tier.
// =============================================================================

import { apiBaseUrl } from "../env";

const ORIGINAL = { url: process.env.API_BASE_URL, env: process.env.NODE_ENV };

/** NODE_ENV is readonly in the Next types; a deployment sets it either way. */
const setEnv = (value: string) => {
  (process.env as Record<string, string>).NODE_ENV = value;
};

afterEach(() => {
  if (ORIGINAL.url === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = ORIGINAL.url;
  setEnv(ORIGINAL.env ?? "test");
});

describe("in production", () => {
  beforeEach(() => setEnv("production"));

  it("REFUSES when the variable is missing, naming it and what to set", () => {
    delete process.env.API_BASE_URL;
    expect(() => apiBaseUrl()).toThrow(/API_BASE_URL is not set/);
    // The message has to carry the way out, or it is just a different blank page.
    expect(() => apiBaseUrl()).toThrow(/backend:3001|Cloud Map/);
  });

  it("REFUSES an EMPTY STRING — the case `??` cannot see", () => {
    // This is the whole reason the check exists: `?? default` treats "" as set.
    process.env.API_BASE_URL = "";
    expect(() => apiBaseUrl()).toThrow(/API_BASE_URL is not set/);
  });

  it("REFUSES whitespace, which is what a mis-pasted secret looks like", () => {
    process.env.API_BASE_URL = "   ";
    expect(() => apiBaseUrl()).toThrow(/API_BASE_URL is not set/);
  });

  it("REFUSES a bare host — a relative fetch resolves to nowhere", () => {
    // `new URL("backend:3001")` PARSES, with protocol "backend:" — which is why
    // a shape check alone is not enough and the protocol is checked by name.
    process.env.API_BASE_URL = "backend:3001";
    expect(() => apiBaseUrl()).toThrow(/API_BASE_URL/);
    expect(() => apiBaseUrl()).toThrow(/backend:3001/);
  });

  it("REFUSES a protocol that is not http(s)", () => {
    process.env.API_BASE_URL = "ftp://backend:3001";
    expect(() => apiBaseUrl()).toThrow(/must be http or https/);
  });

  it("ACCEPTS what the deployment actually sets", () => {
    // docker-compose and the ECS task definition, verbatim in shape.
    process.env.API_BASE_URL = "http://backend:3001";
    expect(apiBaseUrl()).toBe("http://backend:3001");
    process.env.API_BASE_URL = "http://sms-api.sms.local:3001";
    expect(apiBaseUrl()).toBe("http://sms-api.sms.local:3001");
    process.env.API_BASE_URL = "https://api.example.school";
    expect(apiBaseUrl()).toBe("https://api.example.school");
  });

  it("normalises a trailing slash, so `${base}/path` cannot become `//path`", () => {
    // Sixteen call sites each wrote `${API_BASE}/...`; getting this right in one
    // place beats getting it right sixteen times.
    process.env.API_BASE_URL = "http://backend:3001/";
    expect(apiBaseUrl()).toBe("http://backend:3001");
  });
});

describe("outside production", () => {
  beforeEach(() => setEnv("development"));

  it("keeps the localhost default, so local work is untouched", () => {
    delete process.env.API_BASE_URL;
    expect(apiBaseUrl()).toBe("http://localhost:3001");
  });

  it("still uses the variable when one is given", () => {
    process.env.API_BASE_URL = "http://127.0.0.1:4000";
    expect(apiBaseUrl()).toBe("http://127.0.0.1:4000");
  });

  it("still refuses a value that is set but unusable", () => {
    // A developer who mis-set it deserves the same clear answer; the leniency is
    // about an ABSENT variable, not a broken one.
    process.env.API_BASE_URL = "not a url";
    expect(() => apiBaseUrl()).toThrow(/not a URL|must be absolute/);
  });
});

describe("the rule lives in ONE place", () => {
  it("no page or route carries its own localhost fallback any more", () => {
    // It was written out in sixteen files. A rule written sixteen times is right
    // sixteen times until it is not, and cannot be changed once.
    const { readdirSync, statSync, readFileSync } = jest.requireActual<typeof import("node:fs")>("node:fs");
    const { join } = jest.requireActual<typeof import("node:path")>("node:path");
    const web = join(__dirname, "../..");
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        // This file quotes the old expression in prose; the rule is about code.
        if (e === "node_modules" || e === ".next" || e === "__tests__") continue;
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e) && !full.endsWith("lib/env.ts")) {
          scanned += 1;
          const src = readFileSync(full, "utf8");
          if (/API_BASE_URL\s*\?\?/.test(src)) offenders.push(full.slice(web.length + 1));
        }
      }
    };
    walk(join(web, "app"));
    walk(join(web, "lib"));
    walk(join(web, "components"));
    expect(offenders).toEqual([]);
    // A walk that found no files produces no offenders and passes green.
    expect(scanned).toBeGreaterThan(200);
    // ...and the callers really do go through the helper.
    expect(readFileSync(join(web, "lib/api.ts"), "utf8")).toContain("apiBaseUrl()");
  });
});

// -----------------------------------------------------------------------------
// The boot hook — because a throw inside a request is CAUGHT
// -----------------------------------------------------------------------------
// Measured on the built site with the variable unset: /schools answered **200**,
// rendered its shell, and told a prospective parent to "refresh in a moment".
// The page's own try/catch — which exists so an API blip does not claim the
// platform has no schools — swallowed the configuration error whole.
//
// And throwing from instrumentation is not enough either: Next prints "Failed to
// prepare server", then prints "Ready", and serves. So the hook EXITS.
// -----------------------------------------------------------------------------

describe("the boot hook", () => {
  const setRuntime = (v: string | undefined) => {
    if (v === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = v;
  };

  let exit: jest.SpyInstance;
  let err: jest.SpyInstance;

  beforeEach(() => {
    // `process.exit` must not actually end the test worker.
    exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    err = jest.spyOn(console, "error").mockImplementation(() => undefined);
    setRuntime("nodejs");
  });
  afterEach(() => {
    exit.mockRestore();
    err.mockRestore();
    setRuntime(undefined);
  });

  it("EXITS NON-ZERO rather than serving a site that cannot reach the API", async () => {
    setEnv("production");
    delete process.env.API_BASE_URL;
    const { register } = await import("../../instrumentation");
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    // The reason has to be IN THE LOG — a silent exit is a crash-loop nobody
    // can diagnose from a task log.
    expect(err.mock.calls.flat().join(" ")).toMatch(/API_BASE_URL is not set/);
  });

  it("EXITS on the empty string too", async () => {
    setEnv("production");
    process.env.API_BASE_URL = "";
    const { register } = await import("../../instrumentation");
    await register();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("starts normally when the deployment set it", async () => {
    setEnv("production");
    process.env.API_BASE_URL = "http://backend:3001";
    const { register } = await import("../../instrumentation");
    await register();
    expect(exit).not.toHaveBeenCalled();
  });

  it("does nothing on the edge runtime, which serves none of these pages", async () => {
    setEnv("production");
    delete process.env.API_BASE_URL;
    setRuntime("edge");
    const { register } = await import("../../instrumentation");
    await register();
    expect(exit).not.toHaveBeenCalled();
  });

  it("is WIRED UP — without instrumentationHook the file never runs", async () => {
    // A gate that is never invoked is not a gate. Next 14 only loads
    // instrumentation.ts when this flag is on, so the flag IS the gate.
    const { readFileSync } = jest.requireActual<typeof import("node:fs")>("node:fs");
    const { join } = jest.requireActual<typeof import("node:path")>("node:path");
    const config = readFileSync(join(__dirname, "../../next.config.mjs"), "utf8");
    expect(config).toMatch(/instrumentationHook:\s*true/);
  });
});
