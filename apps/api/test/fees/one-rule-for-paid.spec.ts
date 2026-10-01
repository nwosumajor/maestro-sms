/**
 * What makes an invoice PAID is decided in ONE place.
 *
 * Seven writers decided it, spelled five ways (see `invoiceStatusForNet`). Each
 * was right where it stood, and a rule written seven times is the shape that is
 * wrong on the eighth — the integrity sweep checks stored statuses against this
 * same rule, so a writer with its own spelling would be judged by a rule it does
 * not follow.
 *
 * The scan looks for the SHAPE of the decision — a conditional whose branch
 * yields "PAID" — anywhere in source but the helper. Reading `status: "PAID"`
 * in a where-clause is a QUESTION, not a decision, and is not matched.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";
import { invoiceStatusForNet } from "../../src/fees/net-paid";

const SRC = join(__dirname, "../../src");
const HOME = join(SRC, "fees/net-paid.ts");

function sources(): string[] {
  const out: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".spec.ts")) out.push(p);
    }
  })(SRC);
  return out;
}

describe("one rule decides an invoice is PAID", () => {
  const files = sources();

  it("scanned a believable number of sources", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain(HOME);
  });

  it("no source but net-paid.ts decides PAID with a conditional of its own", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (f === HOME) continue;
      const src = stripComments(readFileSync(f, "utf8"));
      // `cond ? "PAID" : …`  or  `… : "PAID"` — a branch that YIELDS the status.
      for (const m of src.matchAll(/\?\s*["']PAID["']\s*:|:\s*["']PAID["']\s*[,)}\n]/g)) {
        // `status: "PAID"` inside an object literal is a where-clause or a write
        // of a constant, not a conditional — skip the object-key form.
        const before = src.slice(Math.max(0, m.index! - 12), m.index!);
        if (/status\s*$/.test(before) || /\bstatus$/.test(before.trim())) continue;
        const line = src.slice(0, m.index).split("\n").length;
        bad.push(`${f.replace(SRC + "/", "")}:${line}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the rule itself", () => {
    expect(invoiceStatusForNet(1_000, 1_000)).toBe("PAID");
    expect(invoiceStatusForNet(1_200, 1_000)).toBe("PAID"); // overpaid is still paid
    expect(invoiceStatusForNet(400, 1_000)).toBe("PARTIALLY_PAID");
    expect(invoiceStatusForNet(0, 1_000)).toBe("ISSUED");
    expect(invoiceStatusForNet(-100, 1_000)).toBe("ISSUED"); // refunded below zero
    // The library's case: nothing paid keeps the current status, so a fine does
    // not issue a DRAFT as a side effect.
    expect(invoiceStatusForNet(0, 1_000, "DRAFT")).toBe("DRAFT");
    expect(invoiceStatusForNet(1_000, 1_000, "DRAFT")).toBe("PAID");
  });
});
