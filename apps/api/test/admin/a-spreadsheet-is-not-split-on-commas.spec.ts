// =============================================================================
// The address that took the class column with it
// =============================================================================
// The import parsed with `line.split(",")`. The template's address column is the
// field most likely to contain a comma, and a spreadsheet quotes such a cell.
// Measured on the real parser before this: `"12 Main St, Ikeja"` gave
//
//     address : "12 Main St
//     class   : Ikeja"
//
// The address was silently truncated AND every later column shifted by one, so
// the pupil enrolled in no class at all. Two corrupt records from one comma, on
// the one path a school uses to load its entire roll — and nothing anywhere said
// so, because `Ikeja"` simply matched no class and the row looked like any other
// pupil awaiting placement.
// =============================================================================

import { parseCsv, parseCsvRows, csvCellOf, SIS_IMPORT_HEADERS } from "@sms/types";

const header = SIS_IMPORT_HEADERS.join(",");

describe("a cell may contain a comma", () => {
  it("keeps the address whole AND the columns after it in place", () => {
    const [row] = parseCsv(
      `${header}\nAda Lovelace,ADM-001,SS3 Science A,2012-05-01,F,,08000000000,"12 Main St, Ikeja",,Lagos,Lagos`,
    );
    expect(row.addressLine1).toBe("12 Main St, Ikeja");
    // The half that made it two defects rather than one.
    expect(row.class).toBe("SS3 Science A");
    expect(row.city).toBe("Lagos");
    expect(row.state).toBe("Lagos");
  });

  it('reads "" as one quote, the way a spreadsheet writes one', () => {
    const [row] = parseCsv(`name,addressLine1\nAda,"The ""Old"" Mill"`);
    expect(row.addressLine1).toBe('The "Old" Mill');
  });

  it("keeps a newline inside a quoted cell inside that cell", () => {
    // A pasted address wraps. Splitting on newline first would make it a pupil.
    const rows = parseCsv(`name,addressLine1\nAda,"12 Main St\nIkeja"\nBolu,7 High St`);
    expect(rows).toHaveLength(2);
    expect(rows[0].addressLine1).toBe("12 Main St\nIkeja");
    expect(rows[1].name).toBe("Bolu");
  });
});

describe("what a spreadsheet actually emits", () => {
  it("survives CRLF line endings", () => {
    const rows = parseCsv("name,city\r\nAda,Lagos\r\nBolu,Abuja\r\n");
    expect(rows.map((r) => r.name)).toEqual(["Ada", "Bolu"]);
    expect(rows[0].city).toBe("Lagos");
  });

  it("strips a UTF-8 BOM instead of hiding it in the first header", () => {
    // Excel writes one. Without this the first header arrives as "﻿name",
    // so EVERY row has no name, the whole file is rejected as empty, and the
    // screen can only say "no valid rows" about a file that looks perfect.
    const [row] = parseCsv("﻿name,city\nAda,Lagos");
    expect(row.name).toBe("Ada");
  });

  it("ignores a trailing blank line rather than counting it as a pupil", () => {
    const rows = parseCsv("name,city\nAda,Lagos\n\n,\n");
    expect(rows).toHaveLength(1);
  });

  it("reads a last row with no trailing newline", () => {
    expect(parseCsv("name,city\nAda,Lagos")).toHaveLength(1);
  });
});

describe("the legacy headers still resolve", () => {
  it("folds `address` onto addressLine1 and `classId` onto class", () => {
    const [row] = parseCsv("name,address,classId\nAda,12 Main St,SS3 Science A");
    expect({ a: row.addressLine1, c: row.class }).toEqual({ a: "12 Main St", c: "SS3 Science A" });
  });
});

describe("csvCellOf writes what parseCsv reads", () => {
  it("round-trips every cell that needs quoting", () => {
    const awkward = ["12 Main St, Ikeja", 'The "Old" Mill', "12 Main St\nIkeja", "plain"];
    const text = `name,addressLine1\n${awkward
      .map((a, i) => [csvCellOf(`P${i}`), csvCellOf(a)].join(","))
      .join("\n")}`;
    expect(parseCsv(text).map((r) => r.addressLine1)).toEqual(awkward);
  });

  it("leaves an ordinary cell unquoted, so the file stays readable", () => {
    expect(csvCellOf("Lagos")).toBe("Lagos");
    expect(parseCsvRows("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});
