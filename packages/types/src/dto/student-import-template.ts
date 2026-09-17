// =============================================================================
// The student-import template — ONE definition, shared by the API and the web
// =============================================================================
// The header list existed TWICE, hand-kept: `TEMPLATE_HEADERS` in
// StudentImportService and `COLS` in SisImport.tsx, with nothing keeping them in
// step. The file is parsed BY HEADER NAME, so a drift between them is not a
// crash — it is a column the school fills in and the platform silently drops.
//
// WHAT BELONGS HERE, and the rule that decides it: a column exists for every
// fact THE SCHOOL is the authority on, plus every field the platform requires
// before a profile counts as complete. Anything else is asked of the family, who
// are the authority on it and who will keep it current.
//
// The gap this closes: `SIS_REQUIRED_PROFILE_FIELDS` demands `city` and `state`
// and the template had no column for either, so a school importing a COMPLETE
// and accurate register still had every pupil land INCOMPLETE and be nudged
// nightly for two fields it was never given anywhere to type. A nudge is
// supposed to mean "we genuinely do not know this"; it meant "the template is
// two columns short". `a-template-that-can-finish-a-profile.spec.ts` now fails
// if a required field has no column.
//
// MEDICAL AND EMERGENCY CONTACTS ARE DELIBERATELY ABSENT and must stay absent.
// They are encrypted, separately audited and staff-owned; a spreadsheet passed
// around an office is the wrong custody for them (Golden Rule #5).
// =============================================================================

/** A column in the import template. */
export interface SisImportColumn {
  /** The header, and the key on the parsed row. */
  key: string;
  /** Shown beside the download so a school knows what to put in it. */
  label: string;
  /** Only `name` is required; everything else may be left blank. */
  required: boolean;
  /**
   * The `StudentProfile` field this fills in, or null. `name`, `email` and
   * `class` drive the account and the enrolment instead.
   *
   * EVERY entry states all four properties, even the nulls. Under `as const` an
   * omitted property is absent from that member's TYPE, so the union loses it
   * and `col.profileField` stops compiling for the whole array — the literal
   * keys are worth more than the brevity.
   */
  profileField: string | null;
  /** What a school should know before typing in this column, or null. Stated on
   *  every entry for the same reason as `profileField` — an omitted property is
   *  absent from that member's type under `as const`. */
  hint: string | null;
}

export const SIS_IMPORT_COLUMNS = [
  { key: "name", label: "Full name", required: true, profileField: null, hint: "The only column that must be filled in." },
  {
    key: "admissionNumber",
    label: "Admission number",
    required: false,
    profileField: "admissionNumber",
    // Strongly advised rather than required: it is the key the GUARDIAN upload
    // matches on (`studentAdmissionNumbers`), and the key an UPDATE matches on.
    // Leave it blank and one is allocated, after which neither can name that
    // pupil.
    hint: "Supply your own if you have one — the guardian upload and any later correction match on it. Blank = allocated for you.",
  },
  { key: "class", label: "Class", required: false, profileField: null, hint: "The class NAME or CODE as it appears on the classes page, e.g. SS3 Science A." },
  { key: "dateOfBirth", label: "Date of birth", required: false, profileField: "dateOfBirth", hint: "YYYY-MM-DD." },
  { key: "gender", label: "Gender", required: false, profileField: "gender", hint: null },
  { key: "email", label: "Email", required: false, profileField: null, hint: "Optional. Blank = a sign-in identifier is generated from the name." },
  { key: "phone", label: "Phone", required: false, profileField: "phone", hint: null },
  { key: "addressLine1", label: "Address line 1", required: false, profileField: "addressLine1", hint: null },
  { key: "addressLine2", label: "Address line 2", required: false, profileField: "addressLine2", hint: null },
  { key: "city", label: "City", required: false, profileField: "city", hint: null },
  { key: "state", label: "State", required: false, profileField: "state", hint: null },
] as const satisfies readonly SisImportColumn[];

/**
 * Every column key, as a UNION.
 *
 * This is what makes the boundary schema impossible to leave behind. The Zod
 * schema validating an upload was a THIRD hand-kept copy of the column list, and
 * it STRIPS what it does not declare — so `city`, `state` and `addressLine2`
 * were accepted by the template, typed by a school, sent by the browser, and
 * silently discarded at the door. Found by driving a real import end to end:
 * every unit test passed, because they call the service directly and never cross
 * the boundary that was dropping them. A validator map typed as
 * `Record<SisImportColumnKey, …>` cannot compile with a column missing.
 */
export type SisImportColumnKey = (typeof SIS_IMPORT_COLUMNS)[number]["key"];

/** The header row, in order. */
export const SIS_IMPORT_HEADERS: readonly SisImportColumnKey[] = SIS_IMPORT_COLUMNS.map((c) => c.key);

/**
 * Columns still accepted but no longer offered.
 *
 * `address` was the single-line address column and `classId` a raw uuid. A file
 * a school built last term must keep importing — the cost of keeping them is one
 * line each in the mapper, and the cost of dropping them is a school's work.
 */
export const SIS_IMPORT_LEGACY_ALIASES: Readonly<Record<string, string>> = {
  address: "addressLine1",
  classId: "class",
};

/**
 * Parse a CSV the way a SPREADSHEET writes one.
 *
 * The web split on "," with no quote handling, which is fine until a column
 * contains a comma — and the template's address column is the field most likely
 * to. Excel writes `"12 Main St, Ikeja"`, and a naive split gave
 * `address: '"12 Main St'` with EVERY LATER COLUMN SHIFTED BY ONE, so the pupil
 * enrolled in a class called `Ikeja"`. The address was silently corrupted and
 * the enrolment silently lost.
 *
 * Handles what a spreadsheet actually emits: quoted fields, embedded commas,
 * embedded newlines, and `""` as an escaped quote. Deliberately a small reader
 * rather than a dependency — this runs in the browser on a file a school picked.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => {
    const key = h.trim();
    return SIS_IMPORT_LEGACY_ALIASES[key] ?? key;
  });
  const out: Record<string, string>[] = [];
  for (const cells of rows.slice(1)) {
    // A row of nothing but empty cells is a trailing blank line in the sheet,
    // not a pupil with no name — dropping it here keeps it out of the count the
    // approver is shown.
    if (cells.every((c) => c.trim() === "")) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      const v = (cells[i] ?? "").trim();
      if (v) row[h] = v;
    });
    out.push(row);
  }
  return out;
}

/** The raw grid: quote-aware, newline-aware. Exported for its own tests. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // Strip a UTF-8 BOM, which Excel writes and which would otherwise become part
  // of the FIRST HEADER — so `name` arrives as `﻿name` and every row loses
  // its name, which reads as a file full of blank pupils.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }  // "" is one quote
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { endField(); continue; }
    if (ch === "\r") continue;               // CRLF: the \n does the work
    if (ch === "\n") { endRow(); continue; }
    field += ch;
  }
  // A file that does not end in a newline still has a last row.
  if (field !== "" || row.length > 0) endRow();
  return rows.filter((r) => r.length > 0);
}

/** Quote a cell for a CSV the same reader can read back. */
export function csvCellOf(value: string | null | undefined): string {
  const v = value ?? "";
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
