// =============================================================================
// What a report card's verification code resolves to
// =============================================================================
// Returned by the PUBLIC verification route to whoever is holding the card — a
// receiving school, an employer, a parent checking a page they were sent.
//
// WHY IT CARRIES THE MARKS. Verification exists to catch a doctored card, and
// the only shape in which a human can do that is one they can compare against
// the page in front of them. A digest cannot be recomputed by eye, so it would
// prove nothing. The person asking already holds the card, so these fields tell
// them nothing they cannot already read; the code is printed on the card and
// nowhere else, and is unguessable, so holding the code IS holding the card.
// =============================================================================

/** One subject line, exactly as it was issued. */
export interface AttestedSubject {
  subject: string;
  total: number | null;
  grade: string | null;
}

export interface ReportCardAttestationDto {
  /** The school that issued it, by name — matched against the card's letterhead. */
  schoolName: string;
  studentName: string;
  className: string | null;
  termName: string;
  sessionName: string | null;

  /** WHO SIGNED IT, as recorded when it was issued. Snapshotted, so this still
   *  reads correctly after the person leaves or their roles change. */
  approvedByName: string;
  approvedByRole: string;
  approvedAt: Date;

  /** WHAT WAS SIGNED. */
  termAverage: number | null;
  termGrade: string | null;
  subjects: AttestedSubject[];

  /** Which issue of this card the code now attests to. A holder whose printout
   *  shows a lower number is holding a superseded document — which is a fact
   *  they need, not an error. */
  version: number;
  issuedAt: Date;
}
