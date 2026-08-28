// =============================================================================
// An export that says when it is short
// =============================================================================
// A capped export is fine. A capped export that looks complete is not: the
// person reading it is reconciling a ledger, chasing an incident or counting
// stock, and nothing in the file, the filename or the download tells them a row
// was dropped.
//
// FOUR downloadable exports carry a row cap. ONE of them — the library
// catalogue — already did this properly, reading one past its limit and
// appending a note, with the reason written beside it: "a librarian
// reconciling stock will not read an HTTP header, but they will see the last
// line." The other three did not.
//
//   fees/export/journal.csv     10,000  -> REFUSES: an accountant's ledger is
//                                          complete or it is not imported
//   operator audit/export.csv    2,000  -> note row (reached by ONE school: the
//                                          demo tenant holds 26,095 audit rows)
//   operator payments/export.csv 20,000 -> note row
//   library books/export.csv    20,000  -> note row (was already correct)
//
// The journal REFUSES rather than annotating, deliberately: a short ledger
// cannot be recovered from by the person reading it, and a refusal naming the
// count is actionable in the moment. The other three annotate, because an audit
// trail and a catalogue are browsed rather than balanced.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * Every capped export: how it fetches one past its limit, how it detects the
 * overflow, and how the READER is told.
 *
 * The patterns are per-file rather than derived from the constant name, because
 * the shapes genuinely differ — the audit export clamps a caller-supplied
 * `limit` against its ceiling, so it cannot literally read
 * `take: AUDIT_EXPORT_MAX + 1`. A gate loose enough to cover both by accident
 * would pass against an export that stopped checking, which is the failure it
 * exists for.
 */
const CAPPED_EXPORTS: Array<{
  rel: string;
  readsOnePast: RegExp;
  detects: RegExp;
  tellsReader: RegExp;
}> = [
  {
    rel: "library/library.service.ts",
    readsOnePast: /take: CATALOGUE_EXPORT_MAX \+ 1/,
    detects: /rowsRaw\.length > CATALOGUE_EXPORT_MAX/,
    tellsReader: /NOTE: truncated at \$\{CATALOGUE_EXPORT_MAX\}/,
  },
  {
    rel: "operator/platform-audit.service.ts",
    readsOnePast: /this\.query\(\{ \.\.\.f, cursor: undefined \}, cap \+ 1\)/,
    detects: /fetched\.length > cap/,
    tellsReader: /NOTE: truncated at \$\{cap\}/,
  },
  {
    rel: "operator/operator-payments.service.ts",
    readsOnePast: /take: MAX_EXPORT_ROWS \+ 1/,
    detects: /fetched\.length > MAX_EXPORT_ROWS/,
    tellsReader: /NOTE: truncated at \$\{MAX_EXPORT_ROWS\}/,
  },
  {
    // The one that REFUSES instead of annotating: an accountant's ledger is
    // complete or it is not imported.
    rel: "fees/fee-ops.service.ts",
    readsOnePast: /take: FeeOpsService\.JOURNAL_ROW_CAP \+ 1/,
    detects: /pays\.length > FeeOpsService\.JOURNAL_ROW_CAP/,
    tellsReader: /BadRequestException\([\s\S]{0,200}narrower ranges/,
  },
];

describe("a capped export never looks complete", () => {
  it("names files that still exist", () => {
    for (const { rel } of CAPPED_EXPORTS) expect({ rel, found: read(rel).length > 0 }).toEqual({ rel, found: true });
  });

  it("reads ONE PAST its cap, so an overflow can be detected", () => {
    // `take: CAP` cannot distinguish "exactly CAP rows" from "more than CAP",
    // and those are different files.
    for (const { rel, readsOnePast } of CAPPED_EXPORTS) {
      expect({ rel, onePast: readsOnePast.test(read(rel)) }).toEqual({ rel, onePast: true });
    }
  });

  it("compares what came back against the cap", () => {
    for (const { rel, detects } of CAPPED_EXPORTS) {
      expect({ rel, detects: detects.test(read(rel)) }).toEqual({ rel, detects: true });
    }
  });

  it("tells the READER — in the file, or by refusing", () => {
    // A `truncated` flag recorded only in our own audit metadata is a fact
    // about the export that the export does not carry. Nobody opening the CSV
    // reads the audit log we wrote about ourselves.
    for (const { rel, tellsReader } of CAPPED_EXPORTS) {
      expect({ rel, tells: tellsReader.test(read(rel)) }).toEqual({ rel, tells: true });
    }
  });
});
