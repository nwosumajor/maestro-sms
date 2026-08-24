// =============================================================================
// Terraform says "" and the app hears "a value"
// =============================================================================
// `process.env.X ?? fallback` is blind to the empty string. Nullish coalescing
// is the CAREFUL operator — it does not treat `0` or `false` as absent — and for
// environment variables, which are always strings, that carefulness is exactly
// wrong: the one falsy value a variable can hold is `""`, and it means unset.
//
// Nothing checked the boundary. Seven variables reach the ECS tasks from
// Terraform variables declared with `default = ""`, so a deployment that simply
// does not set one hands the container an EMPTY STRING rather than an absent
// variable, and every `??` behind it silently fails to fire.
//
// Two of the seven were live defects, and both were on the path to a real
// person:
//
//   EMAIL_FROM            `?? DEFAULT_FROM` never fired, so every outbound email
//                         would carry a blank From and be rejected by the
//                         provider. Receipts, invites and password resets simply
//                         stop, and the only trace is a WARN per message.
//
//   TWILIO_WHATSAPP_FROM  `?? process.env.TWILIO_FROM` never fired, so the
//                         fallback the comment beside it described was
//                         unreachable. The empty sender then hit a branch that
//                         returned { ok: true } — and `ok` is what decides
//                         whether to DEBIT A PAID MESSAGE CREDIT. The school was
//                         charged for every WhatsApp message, none were sent,
//                         and each was recorded SENT.
//
// The other five are safe, and worth knowing WHY rather than by luck:
// `if (process.env.SENTRY_DSN)` and `SMS_PROVIDER === "twilio"` both handle ""
// correctly, because a truthy test and an equality test are not fallbacks.
//
// This gate reads BOTH SIDES — the Terraform variable declarations and the app's
// reads — because neither file can see the other, and a typecheck certainly
// cannot.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { envIsSet, envOr, envOrNull } from "../../src/common/env";
import { join } from "node:path";

const REPO = join(__dirname, "../../../..");
const TF = join(REPO, "infrastructure/terraform");
const API_SRC = join(__dirname, "../../src");

/**
 * EVERY environment variable this deployment ships into the ECS tasks.
 *
 * Keyed on what is SHIPPED, not on which Terraform variables currently default
 * to `""`. The first version of this gate used the empty-default set, and
 * removing one bad default silently switched off the check on the app side —
 * the fix disabled the test that proved the fix. Anything an operator can type
 * into a task definition can arrive blank, so the rule is simply: a variable
 * this deployment ships is never read with `??`.
 */
function shippedEnvVars(): string[] {
  const src = readFileSync(join(TF, "ecs.tf"), "utf8");
  return [...new Set([...src.matchAll(/\{\s*name\s*=\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]))];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".ts") && !f.endsWith(".spec.ts")) out.push(f);
  }
  return out;
}

/**
 * Comments out. Several of these files now carry a comment QUOTING the defect
 * they were fixed for — `?? process.env.TWILIO_FROM never fires` — and a scan
 * that reads prose fails on the explanation of its own fix. This gate did
 * exactly that on its first run.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const SOURCES = walk(API_SRC).map((f) => ({
  file: f.slice(API_SRC.length + 1),
  src: stripComments(readFileSync(f, "utf8")),
}));

describe("environment variables this deployment ships", () => {
  const shipped = shippedEnvVars();

  it("are actually being looked for", () => {
    // If the extraction breaks, this gate would pass by finding nothing.
    expect(shipped.length).toBeGreaterThan(20);
  });

  it("are never read with a `??` fallback, which cannot see an empty string", () => {
    const offenders: string[] = [];
    for (const env of shipped) {
      const pattern = new RegExp(`process\\.env\\.${env}\\s*\\?\\?`);
      for (const { file, src } of SOURCES) {
        if (pattern.test(src)) offenders.push(`${file}: process.env.${env} ?? … (an empty value never reaches the fallback)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("are never the RIGHT-hand side of a `??` either", () => {
    // `A ?? process.env.B` is the same trap wearing a different hat, and it is
    // the exact shape the WhatsApp sender used.
    const offenders: string[] = [];
    for (const env of shipped) {
      const pattern = new RegExp(`\\?\\?\\s*process\\.env\\.${env}\\b`);
      for (const { file, src } of SOURCES) {
        if (pattern.test(src)) offenders.push(`${file}: … ?? process.env.${env} (an empty value is still "set")`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the reader that treats blank as unset", () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  it("reports blank, whitespace and unset alike as absent", () => {
    process.env = { ...env, A_BLANK: "", A_SPACES: "   " };
    delete process.env.A_MISSING;
    for (const name of ["A_BLANK", "A_SPACES", "A_MISSING"]) {
      expect([name, envOrNull(name)]).toEqual([name, null]);
      expect([name, envIsSet(name)]).toEqual([name, false]);
      expect([name, envOr(name, "fallback")]).toEqual([name, "fallback"]);
    }
  });

  it("returns a real value trimmed, and does not swallow it", () => {
    process.env = { ...env, A_SET: "  hello  " };
    expect(envOrNull("A_SET")).toBe("hello");
    expect(envOr("A_SET", "fallback")).toBe("hello");
  });

  it("does not treat the string \"0\" or \"false\" as absent", () => {
    // The reason `??` was reached for in the first place. Keep that property.
    process.env = { ...env, A_ZERO: "0", A_FALSE: "false" };
    expect(envOrNull("A_ZERO")).toBe("0");
    expect(envOrNull("A_FALSE")).toBe("false");
  });
});

describe("the sending domain, which is a fact about the deployment", () => {
  it("has no Terraform default at all, so a plan cannot quietly ship a blank one", () => {
    const src = readFileSync(join(TF, "variables.tf"), "utf8");
    const block = /variable\s+"email_from"\s*\{([\s\S]*?)\n\}/.exec(src);
    expect(block).toBeTruthy();
    expect(block![1]).not.toMatch(/default\s*=/);
  });
});
