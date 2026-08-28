// =============================================================================
// A minor's medical record is only ever WRITTEN encrypted
// =============================================================================
// Golden Rule #5 and the field-crypto note both state that medical fields are
// "ciphertext at rest, decrypted only for authorized readers". ONE writer exists
// and it is correct: `SisService.upsertMedical` passes every sensitive column
// through `encryptField`. Nothing made that true of a SECOND writer.
//
// It is worth a gate for a reason this repo already records about these columns:
// they are NOT `*Enc`-suffixed like the HR ones (`bloodGroup`, `allergies`,
// `conditions`, `medications`), so a `%Enc` search under-reports what is
// protected, and somebody adding a bulk import or an admissions conversion has
// no naming cue telling them the column is encrypted at all.
//
// // GOTCHA THAT PROMPTED IT, and it was mine: measuring the demo database shows
// 150 medical rows in PLAINTEXT against one encrypted, which reads exactly like
// a defect and is not. The 150 come from `scripts/seed-volume.sql`, a local
// performance fixture that writes rows directly — and that file ALREADY says so
// ("NOTE: seeded as PLAINTEXT ... this does NOT exercise the decrypt cost that
// real, app-written records carry"). I measured before reading it. Asking WHICH
// WRITER produced the rows is what separates a fixture artefact from a product
// defect; the third case below keeps that note from being deleted.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

/** The sensitive columns, named because nothing in them says "encrypted". */
const SENSITIVE = ["bloodGroup", "allergies", "conditions", "medications", "dietaryNotes", "notes"];
const WRITES = /medicalRecord\.(?:create|update|upsert|createMany|updateMany)\(/;

describe("writing a minor's medical record", () => {
  const files = sourceFiles(SRC);

  it("has writers to check at all", () => {
    // A gate that finds no writers passes while covering nothing.
    expect(files.filter((f) => WRITES.test(readFileSync(f, "utf8"))).length).toBeGreaterThanOrEqual(1);
  });

  it("passes every sensitive column through encryptField", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.split("/src/")[1];
      const src = readFileSync(f, "utf8");
      if (!WRITES.test(src)) continue;
      if (!src.includes("encryptField")) {
        offenders.push(`${rel} writes a medical record and never calls encryptField`);
        continue;
      }
      // Each column encrypted, not most of them: a writer that covers five of
      // six is the shape this exists to catch.
      for (const col of SENSITIVE) {
        if (!new RegExp(`${col}:\\s*encryptField\\(`).test(src)) {
          offenders.push(`${rel} writes ${col} without encryptField`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the local volume fixture still says its rows are not the product's work", () => {
    const seed = readFileSync(join(__dirname, "../../scripts/seed-volume.sql"), "utf8");
    expect(seed).toMatch(/seeded as PLAINTEXT/i);
  });
});
