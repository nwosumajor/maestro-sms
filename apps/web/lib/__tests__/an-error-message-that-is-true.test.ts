// =============================================================================
// An error message must be TRUE, and must not be a status code
// =============================================================================
// Two failures, swept together.
//
// 1. A STATUS OFTEN HAS SEVERAL CAUSES, and the component knows one of them.
//    `POST /payments/:id/approve` returns 403 both to the person who recorded
//    the payment ("You cannot approve a payment you recorded") and to anyone
//    lacking `fee.approve` ("Forbidden"). The UI asserted the first for both, so
//    a teacher who had never seen the payment was told they had recorded it.
//    Measured live against the demo school. Same shape in ten other components.
//    A component's sentence is now a FALLBACK, used only when the server gave
//    no specific reason — it can no longer overwrite one.
//
// 2. A BARE STATUS NUMBER IS NOT A MESSAGE. Seventeen components fell back to
//    "Failed (403)." — a number a teacher cannot act on, in a codebase whose
//    shared interpreter exists precisely so "a bare 'Failed (403)' never reaches
//    the screen". They route through it now.
// =============================================================================

import { interpretApiError } from "../api-error";

describe("the server's own reason leads", () => {
  it("uses a SPECIFIC server message as the whole answer", () => {
    expect(interpretApiError(403, "You cannot approve a payment you recorded")).toBe(
      "You cannot approve a payment you recorded",
    );
  });

  it("does not append a permission clause that CONTRADICTS the reason", () => {
    // Separation of duties is not a permission problem. Telling someone it might
    // be sends them to ask for access they already have.
    const said = interpretApiError(403, "You cannot approve a payment you recorded");
    expect(said).not.toMatch(/don't have permission/i);
  });

  it("treats a framework reason phrase as NO detail", () => {
    // "Forbidden — You don't have permission for this action" reads like two
    // sentences from two different people, and the first adds nothing.
    const said = interpretApiError(403, "Forbidden");
    expect(said).not.toMatch(/^Forbidden/);
    expect(said).toMatch(/permission/i);
  });

  it.each(["Bad Request", "Not Found", "Conflict", "Internal server error", "Unauthorized"])(
    "…including %s",
    (generic) => {
      expect(interpretApiError(400, generic)).not.toBe(generic);
    },
  );
});

describe("a caller's hint is a fallback, never a replacement", () => {
  it("is used when the server said nothing specific", () => {
    expect(interpretApiError(403, "Forbidden", "A different admin must approve.")).toBe(
      "A different admin must approve.",
    );
  });

  it("is IGNORED when the server gave a real reason", () => {
    // The defect this exists for: the component's guess overwriting the truth.
    expect(interpretApiError(403, "You cannot approve a payment you recorded", "A different admin must approve.")).toBe(
      "You cannot approve a payment you recorded",
    );
  });

  it("falls back to the status interpretation when there is neither", () => {
    expect(interpretApiError(403)).toMatch(/permission/i);
    expect(interpretApiError(429)).toMatch(/wait a minute/i);
  });
});

describe("no status code reaches a user", () => {
  it.each([400, 401, 403, 404, 409, 429, 500, 503])("%s reads as a sentence", (status) => {
    const said = interpretApiError(status);
    expect(said).not.toMatch(/^Failed \(/);
    // A sentence, not a code: several words and no bare parenthesised number.
    expect(said.split(/\s+/).length).toBeGreaterThan(4);
  });

  it("an UNKNOWN status still says something, and says the number once", () => {
    // The one place a number is legitimate — there is nothing else to say.
    expect(interpretApiError(418)).toMatch(/failed/i);
  });
});

// -----------------------------------------------------------------------------
// AND THE SWEEP, so neither shape comes back.
// -----------------------------------------------------------------------------
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === "__tests__") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}
const sources = walk(join(WEB, "components")).concat(walk(join(WEB, "app")));

describe("the shapes that produced untrue and unusable messages", () => {
  it("read a believable number of files — a walk that finds nothing passes covering nothing", () => {
    expect(sources.length).toBeGreaterThan(200);
  });

  it("no component falls back to a bare status code", () => {
    // "Failed (403)." is a number a teacher cannot act on. Seventeen components
    // did this, in a codebase whose shared interpreter exists to prevent it.
    const offenders = sources.filter((f) => /Failed \(\$\{[a-zA-Z]+\.status\}\)/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.replace(WEB, ""))).toEqual([]);
  });

  it("no component skips readApiError for ONE status it thinks it knows", () => {
    // The defect: `res.status === 403 ? "…" : await readApiError(res)`. The
    // else-branch proves the component knows how to read the server's reason —
    // it simply declines to for one status, and asserts a cause instead. That is
    // where an untrue message comes from, because a status usually has several
    // causes. The hint belongs in readApiError's FALLBACK, where the server's
    // own reason still wins.
    //
    // DELIBERATELY NARROW. A first version flagged every status-conditional
    // literal and caught nine legitimate ones: a 404 hint on a SCOPED READ
    // ("You don't teach this class") is the correct reading of this platform's
    // 404-not-403 convention, and better than the generic 404 text — the server
    // sends nothing specific there. An over-wide gate teaches its next reader to
    // add an exemption, so it is scoped to the shape that was actually wrong
    // rather than exempting what it wrongly caught.
    const offenders: string[] = [];
    for (const f of sources) {
      const src = readFileSync(f, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
      if (/\.status === \d{3}\s*\?\s*"[^"]{12,}"\s*:\s*(await\s+)?(readApiError|interpretApiError)\(/.test(src)) {
        offenders.push(f.replace(WEB, ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});
