
// =============================================================================
// How big a roll one upload may carry
// =============================================================================
// An import mints ONE bcrypt secret per person, and bcrypt is deliberately slow:
// MEASURED against the running stack, ~145 ms a head. So 1,000 rows — what the
// boundary used to accept — is a 132-SECOND request, and the proxy in front of
// the app gives up at sixty.
//
// That matters more than a slow page, because THE LOGIN SLIPS RIDE ONLY ON THAT
// RESPONSE. They are shown once and never stored (a stored temp password is a
// stored credential). A response the client never receives therefore creates a
// thousand pupils that nobody can sign in as, recoverable only by resetting each
// password by hand.
//
// So the boundary refuses a file it cannot finish, BEFORE anything is created,
// and names the number and the remedy. Refusing is the restrictive option and
// the recoverable one: splitting a file costs a minute, losing a thousand slips
// does not.
//
// // THE BETTER ANSWER, deliberately not taken here: approve immediately, hash in
// a background job, and let the approver fetch the slips once from the batch.
// That keeps any size — and it means holding credentials at rest for a window,
// which is a security decision for the platform owner rather than a tidy-up.
// =============================================================================
export const BULK_IMPORT_MAX_ROWS = 200;

/** The refusal both bulk importers give, so the two cannot word it differently. */
export function bulkImportTooLarge(kind: "student" | "parent", rows: number): string {
  const who = kind === "student" ? "pupils" : "guardians";
  return (
    `This file has ${rows} ${who}, and one upload carries at most ${BULK_IMPORT_MAX_ROWS}. ` +
    `Split it into files of ${BULK_IMPORT_MAX_ROWS} or fewer and upload them one after another — ` +
    `each one issues its own sign-in slips, and those are shown only once.`
  );
}
