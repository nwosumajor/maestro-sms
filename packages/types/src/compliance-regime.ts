// =============================================================================
// Privacy regimes — what a school is actually subject to
// =============================================================================
// The platform recognised three values: NDPR, GDPR and NONE. Two problems, both
// on the one screen whose entire job is to be accurate about legal obligations.
//
// 1. "NONE" was assigned to 34 of 37 countries and reads as "no privacy law
//    applies here". That is false for most of them. Kenya has the Data
//    Protection Act 2019, South Africa POPIA, Ghana the Data Protection Act
//    2012 — and the posture screen told those schools, affirmatively, that no
//    Data Protection Officer was required. Saying nothing would have been safer
//    than saying that.
//
// 2. The 72-hour breach clock was a flat constant applied to every school as
//    though it were their statutory deadline. It genuinely is under GDPR Art.
//    33, Nigeria's NDPA and Kenya's DPA — but POPIA sets no fixed hours ("as
//    soon as reasonably possible"), and for a country whose law is not modelled
//    here, a statutory-looking countdown invents a deadline out of nothing.
//
// So a regime is a small data table, and it carries `modelled`. This is the same
// posture the payroll packs already take: Nigeria and the UK are implemented and
// everything else REFUSES rather than emitting a confidently wrong number. The
// difference is that a breach register is useful to every school whether or not
// we model their law, so this degrades rather than refuses — it keeps the tool
// and drops the legal claim.
//
// LEGAL FIGURES ARE NOT LEGAL ADVICE. These deadlines and role names must be
// checked against the current statute before a school relies on them, exactly as
// the UK payroll pack says of HMRC thresholds. What the code guarantees is that
// it will not state a requirement for a country it has no rules for.
// =============================================================================

export interface ComplianceProfile {
  key: string;
  /** What the regime is called, as the school's own DPO would name it. */
  label: string;
  /** Who a breach is reported TO. Null when we do not model the country. */
  authority: string | null;
  /**
   * Hours from becoming aware to notifying the authority.
   *
   * `null` means the statute sets no fixed period (POPIA's "as soon as
   * reasonably possible"). It does NOT mean "no obligation" — the register still
   * runs a target, it is just labelled as practice rather than as law.
   */
  breachNotifyHours: number | null;
  /** Whether this regime requires a designated privacy officer. */
  officerRequired: boolean;
  /** What that officer is CALLED. POPIA's is an "Information Officer", and a
   *  screen asking a South African school for a "DPO" is asking for the wrong
   *  thing by the wrong name. */
  officerTitle: string;
  /**
   * FALSE when the platform does not model this country's law.
   *
   * The load-bearing field. Everything downstream must present an unmodelled
   * regime as "we do not know your obligations" and never as "you have none".
   */
  modelled: boolean;
  /** One line the posture screen shows verbatim. */
  note: string;
}

/** The strictest common deadline, and the default TARGET when a regime sets no
 *  fixed period or is not modelled. Shown as practice, never as statute. */
export const DEFAULT_BREACH_TARGET_HOURS = 72;

export const COMPLIANCE_PROFILES: Record<string, ComplianceProfile> = {
  GDPR: {
    key: "GDPR",
    label: "UK/EU GDPR",
    authority: "the supervisory authority",
    breachNotifyHours: 72,
    officerRequired: true,
    officerTitle: "Data Protection Officer",
    modelled: true,
    note: "Art. 33 requires notification within 72 hours of becoming aware; Art. 34 requires telling affected people separately when the risk is high.",
  },
  NDPR: {
    key: "NDPR",
    label: "Nigeria NDPR / NDPA",
    authority: "the NDPC",
    breachNotifyHours: 72,
    officerRequired: true,
    officerTitle: "Data Protection Officer",
    modelled: true,
    note: "The NDPA requires notification to the Commission within 72 hours of becoming aware.",
  },
  KE_DPA: {
    key: "KE_DPA",
    label: "Kenya Data Protection Act 2019",
    authority: "the Office of the Data Protection Commissioner",
    breachNotifyHours: 72,
    officerRequired: true,
    officerTitle: "Data Protection Officer",
    modelled: true,
    note: "Notification to the Data Commissioner is required within 72 hours of becoming aware.",
  },
  POPIA: {
    key: "POPIA",
    label: "South Africa POPIA",
    authority: "the Information Regulator",
    // POPIA sets no fixed number of hours. Presenting 72 as the statutory
    // deadline here would be inventing one.
    breachNotifyHours: null,
    officerRequired: true,
    officerTitle: "Information Officer",
    modelled: true,
    note: "POPIA requires notification as soon as reasonably possible after discovery — there is no fixed hour count. An Information Officer is mandatory and registered with the Regulator.",
  },
  GH_DPA: {
    key: "GH_DPA",
    label: "Ghana Data Protection Act 2012",
    authority: "the Data Protection Commission",
    breachNotifyHours: null,
    officerRequired: true,
    officerTitle: "Data Protection Supervisor",
    modelled: true,
    note: "Notification is required as soon as reasonably practicable; data controllers register with the Commission.",
  },
  UNSPECIFIED: {
    key: "UNSPECIFIED",
    label: "Not modelled for this country",
    authority: null,
    breachNotifyHours: null,
    officerRequired: false,
    officerTitle: "Data Protection Officer",
    modelled: false,
    note:
      "This platform does not model your country's data-protection law, and most countries have one. " +
      "The register below still works and is worth keeping — but the target shown is general good practice, " +
      "not your statutory deadline. Confirm your obligations locally.",
  },
};

/**
 * Resolve a stored regime value.
 *
 * "NONE" is accepted as a legacy alias for UNSPECIFIED: it is what existing rows
 * hold, and it must not resolve to nothing. Renaming the meaning without a data
 * migration is the point — the value stays, the claim it makes changes.
 */
export function complianceProfile(key: string | null | undefined): ComplianceProfile {
  if (!key || key === "NONE") return COMPLIANCE_PROFILES.UNSPECIFIED;
  return COMPLIANCE_PROFILES[key] ?? COMPLIANCE_PROFILES.UNSPECIFIED;
}

/** The hours a breach register should count against, and whether that number is
 *  the law or merely a sensible target. Never returns null: an unmodelled school
 *  still gets a working clock, correctly labelled. */
export function breachTarget(key: string | null | undefined): { hours: number; statutory: boolean } {
  const p = complianceProfile(key);
  return p.breachNotifyHours === null
    ? { hours: DEFAULT_BREACH_TARGET_HOURS, statutory: false }
    : { hours: p.breachNotifyHours, statutory: true };
}
