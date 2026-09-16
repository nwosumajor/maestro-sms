// =============================================================================
// A template a school can fill in completely and still be chased for
// =============================================================================
// `SIS_REQUIRED_PROFILE_FIELDS` decides when a pupil's profile counts as
// COMPLETE — and the import template had no column for two of them, `city` and
// `state`. So a school that imported an accurate, complete register still had
// EVERY pupil land INCOMPLETE and get nudged nightly, together with their
// guardians, for two facts it had never been offered anywhere to type.
//
// A nudge is supposed to mean "we genuinely do not know this". It meant "the
// template is two columns short", and nothing in the product could tell the
// difference — which is the silent-success shape this repo keeps recording,
// pointed at families rather than at an operator.
//
// The two lists live in different files and are edited by different concerns
// (one is a privacy/completeness decision, the other a spreadsheet), so they
// will drift again unless something reads both.
// =============================================================================

import {
  SIS_IMPORT_COLUMNS,
  SIS_IMPORT_HEADERS,
  SIS_REQUIRED_PROFILE_FIELDS,
  missingProfileFields,
  parseCsv,
} from "@sms/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";
import { StudentImportService } from "../../src/admin/student-import.service";

const service = new StudentImportService({} as never, {} as never);

describe("every field a profile needs has somewhere to be typed", () => {
  it("gives each required profile field its own column", () => {
    const filled = new Set(
      SIS_IMPORT_COLUMNS.map((c) => c.profileField).filter((f) => f !== null),
    );
    const orphans = SIS_REQUIRED_PROFILE_FIELDS.filter((f) => !filled.has(f));
    expect(orphans).toEqual([]);
  });

  it("produces a COMPLETE profile from the template's own worked example", () => {
    // The strongest form of the property: take the file the product hands a
    // school, read the row it holds up as the example, and check that a pupil
    // created from it needs no chasing at all. Asserting on the column list
    // alone would pass with an example that leaves the new columns blank.
    const rows = parseCsv(service.csvTemplate());
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const profile: Record<string, unknown> = {};
    for (const col of SIS_IMPORT_COLUMNS) {
      if (col.profileField) profile[col.profileField] = rows[0][col.key] ?? null;
    }
    expect(missingProfileFields(profile as never)).toEqual([]);
  });

  it("and the SPARSE example is honestly incomplete, so the blanks are visible", () => {
    // The second example exists to show what may be left out. If it were also
    // complete the file would teach a school nothing about which blanks cost
    // them a reminder.
    const rows = parseCsv(service.csvTemplate());
    const profile: Record<string, unknown> = {};
    for (const col of SIS_IMPORT_COLUMNS) {
      if (col.profileField) profile[col.profileField] = rows[1][col.key] ?? null;
    }
    expect(missingProfileFields(profile as never).length).toBeGreaterThan(0);
  });
});

describe("the template is ONE definition", () => {
  it("writes the header row from the shared column list", () => {
    const header = service.csvTemplate().split("\n")[0];
    expect(header).toBe(SIS_IMPORT_HEADERS.join(","));
  });

  it("round-trips through the parser it ships with", () => {
    // The template contains an address with a comma ON PURPOSE — it is the cell
    // a school is most likely to have one in, and a template that its own
    // reader cannot read is worse than no example.
    const rows = parseCsv(service.csvTemplate());
    expect(rows[0].addressLine1).toBe("12 Main St, Ikeja");
    expect(rows[0].class).toBe("SS3 Science A");
  });

  it("keeps accepting a file a school built under the OLD headers", () => {
    // `address` and `classId` were the old spellings. Dropping them would cost a
    // school its work for no gain.
    const legacy = [
      "name,email,admissionNumber,dateOfBirth,gender,phone,address,class",
      "Ada Lovelace,ada@example.com,ADM-001,2012-05-01,F,08000000000,12 Main St,SS3 Science A",
    ].join("\n");
    const [row] = parseCsv(legacy);
    expect(row.addressLine1).toBe("12 Main St");
    expect(row.class).toBe("SS3 Science A");
  });
});

describe("the screen sends every column the template offers", () => {
  // THE PROPERTY THE GENERIC SURFACE GATE CANNOT PROVE. That gate asks whether
  // the web MENTIONS an identifier, and the import screen builds its payload by
  // iterating `SIS_IMPORT_COLUMNS`, so no column appears as a literal anywhere
  // in the web. Merging the shared table into what it greps stops it reporting
  // a false gap — but it would then be satisfied by a screen that only DISPLAYS
  // the table, which is the caveat that gate's own header states.
  //
  // So the coverage is asserted here, against the component, where it is real.

  const SRC = readFileSync(
    join(__dirname, "..", "..", "..", "web", "components", "admin", "SisImport.tsx"),
    "utf8",
  );

  it("builds the request by ITERATING the shared column table", () => {
    // Not by hand-listing fields. A hand-listed mapper is how `city` and `state`
    // came to be offered by the template and dropped on the way to the server.
    const stripped = stripComments(SRC);
    expect(stripped).toMatch(/for \(const col of SIS_IMPORT_COLUMNS\)/);
    expect(stripped).toMatch(/row\[col\.key\]\s*=/);
  });

  it("parses with the SHARED quote-aware reader, not a local split", () => {
    const stripped = stripComments(SRC);
    expect(stripped).toMatch(/\bparseCsv\b/);
    // The defect this replaced: `line.split(",")` truncated an address at its
    // comma and shifted every later column.
    expect(stripped).not.toMatch(/\.split\(","\)/);
  });
});
