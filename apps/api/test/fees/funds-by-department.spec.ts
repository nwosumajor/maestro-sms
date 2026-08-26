// =============================================================================
// What each part of the school brought in
// =============================================================================
// Hostel rent, transport fares, library fines and tuition all land on the SAME
// `invoice_line_item` table — deliberately, so a family gets one bill and one
// balance. What that cost was any way to ask "what did boarding bring in?".
//
// // GOTCHA: the only thing that LOOKED like an answer was the line's
// `description`, and attributing money by it would have been worse than no
// report at all. Hostel writes `input.description ?? "Hostel rent"` and
// transport `input.description ?? "Transport fare"` — operator-supplied free
// text. A bursar typing "Boarding — Michaelmas" produces a line
// indistinguishable from tuition, and the figures would drift silently as
// schools worded their own fee runs.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FEE_SOURCES, FEE_SOURCE_LABELS, isFeeSource } from "@sms/types";

const SRC = join(__dirname, "..", "..", "src");

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    out = statSync(p).isDirectory() ? out.concat(walk(p)) : p.endsWith(".ts") ? out.concat(p) : out;
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("the taxonomy", () => {
  it("labels every source, so no screen has to invent a name", () => {
    for (const s of Object.values(FEE_SOURCES)) {
      expect(FEE_SOURCE_LABELS[s]).toBeTruthy();
    }
  });

  it("does not accept something that merely looks like one", () => {
    expect(isFeeSource("HOSTEL")).toBe(true);
    expect(isFeeSource("Hostel rent")).toBe(false);
    expect(isFeeSource("UNATTRIBUTED")).toBe(false);
  });
});

describe("every charge records where it came from", () => {
  // Each creation site, and what it must stamp. Named rather than derived: the
  // point is that a NEW one has to be added here deliberately.
  const SITES: Array<{ file: string; source: string }> = [
    { file: "hostel/hostel.service.ts", source: "FEE_SOURCES.HOSTEL" },
    { file: "transport/transport.service.ts", source: "FEE_SOURCES.TRANSPORT" },
    { file: "library/library.service.ts", source: "FEE_SOURCES.LIBRARY" },
    { file: "fees/fees.service.ts", source: "FEE_SOURCES.TUITION" },
    { file: "fees/fee-ops.service.ts", source: "FEE_SOURCES.ADJUSTMENT" },
  ];

  it.each(SITES)("$file stamps $source", ({ file, source }) => {
    expect(stripComments(readFileSync(join(SRC, file), "utf8"))).toContain(source);
  });

  it("the late-fee sweep stamps its own, not the source it is charged against", () => {
    expect(stripComments(readFileSync(join(SRC, "fees/fee-ops.service.ts"), "utf8"))).toContain("FEE_SOURCES.LATE_FEE");
  });

  it("leaves NO line-item write without one", () => {
    // The whole property. A site that forgets produces revenue attributed to
    // nothing, and the report would quietly under-count a department rather
    // than fail — the confident-false-statement shape this repo keeps meeting.
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const src = stripComments(readFileSync(f, "utf8"));
      for (const m of src.matchAll(/invoiceLineItem\.(create|createMany)\(\{/g)) {
        let d = 1, i = m.index! + m[0].length;
        while (i < src.length && d > 0) {
          if (src[i] === "{") d++;
          else if (src[i] === "}") d--;
          i++;
        }
        if (!/\bsource:/.test(src.slice(m.index!, i))) offenders.push(`${f.split("/src/")[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("found the writes at all — the scan has not silently broken", () => {
    const n = walk(SRC).filter((f) => /invoiceLineItem\.(create|createMany)\(/.test(readFileSync(f, "utf8"))).length;
    expect(n).toBeGreaterThanOrEqual(4);
  });
});

describe("the report", () => {
  const src = stripComments(readFileSync(join(SRC, "fees/fees.service.ts"), "utf8"));

  it("groups by CURRENCY and never sums across", () => {
    // Invoices carry their own currency per row — this platform bills USD
    // through Stripe beside a school's local rail — so one figure would be kobo
    // added to cents. Eight places in this codebase have made that mistake.
    expect(src).toMatch(/GROUP BY 1, 2/);
    expect(src).toMatch(/SELECT i\.currency/);
  });

  it("counts an unattributed line as its own bucket, never as tuition", () => {
    expect(src).toContain("'UNATTRIBUTED'");
    expect(src).not.toMatch(/COALESCE\(li\."source", 'TUITION'\)/);
  });

  it("treats a REFUND as subtracting, like the invoice balance does", () => {
    expect(src).toMatch(/kind = 'REFUND' THEN -pm\."amountMinor"/);
  });

  it("excludes CANCELLED invoices — an unissued bill is not revenue", () => {
    expect(src).toMatch(/i\.status <> 'CANCELLED'/);
  });

  it("reports how much of the collected figure rests on apportionment", () => {
    // A payment settles an invoice, not a line. Saying nothing would let a
    // convention read as a measurement.
    expect(src).toMatch(/mixed_collected/);
    expect(src).toMatch(/source_count > 1/);
  });
});
