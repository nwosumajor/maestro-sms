// Pure demographic bucketing helpers — shared by school + platform analytics so
// the same free-text gender / birth date always maps to the same chart bucket.

/** Normalise a free-text gender field to a stable chart label. */
export function normalizeGender(g: string | null | undefined): "Male" | "Female" | "Other" {
  const v = (g ?? "").trim().toLowerCase();
  if (v === "m" || v === "male" || v === "boy") return "Male";
  if (v === "f" || v === "female" || v === "girl") return "Female";
  return "Other";
}

/** Age (whole years) at `asOf` from a birth date, or null if unknown. */
export function ageYears(dob: Date | string | null | undefined, asOf: Date = new Date()): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  let age = asOf.getFullYear() - d.getFullYear();
  const m = asOf.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && asOf.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/** Bucket a birth date into a school age band. */
export function ageBand(dob: Date | string | null | undefined, asOf: Date = new Date()): string {
  const a = ageYears(dob, asOf);
  if (a === null) return "Unknown";
  if (a <= 5) return "5 & under";
  if (a <= 10) return "6–10";
  if (a <= 13) return "11–13";
  if (a <= 16) return "14–16";
  if (a <= 18) return "17–18";
  return "19+";
}
