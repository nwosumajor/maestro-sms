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
   * When the authority must be told.
   *
   * THREE states, and collapsing any two of them is how this goes wrong:
   *
   *   hours            the statute names a period, and we have it
   *   no-fixed-period  the statute deliberately names none (POPIA's "as soon as
   *                    reasonably possible") — an absence we can assert
   *   unknown          a law exists and we have NOT established its deadline.
   *                    Not the same as "there is none", and the screen must not
   *                    round it to one.
   *
   * The third exists because most of the regimes added here are ones where the
   * law and the regulator are well established but the exact notification window
   * is precisely the detail a wrong answer does most damage on: a school that
   * misses a 48-hour deadline because this table said 72 is worse off than one
   * told to go and check.
   */
  breachNotify: { kind: "hours"; hours: number } | { kind: "no-fixed-period" } | { kind: "unknown" };
  /**
   * Whether this regime requires a designated privacy officer.
   *
   * FALSE is a real answer for the older francophone statutes, which are built
   * on DECLARATION to the authority rather than on an internal officer. Where
   * that is so, `note` says what IS required instead — a false here must never
   * read as "nothing is required".
   */
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
    breachNotify: { kind: "hours", hours: 72 },
    officerRequired: true,
    officerTitle: "Data Protection Officer",
    modelled: true,
    note: "Art. 33 requires notification within 72 hours of becoming aware; Art. 34 requires telling affected people separately when the risk is high.",
  },
  NDPR: {
    key: "NDPR",
    label: "Nigeria NDPR / NDPA",
    authority: "the NDPC",
    breachNotify: { kind: "hours", hours: 72 },
    officerRequired: true,
    officerTitle: "Data Protection Officer",
    modelled: true,
    note: "The NDPA requires notification to the Commission within 72 hours of becoming aware.",
  },
  KE_DPA: {
    key: "KE_DPA",
    label: "Kenya Data Protection Act 2019",
    authority: "the Office of the Data Protection Commissioner",
    breachNotify: { kind: "hours", hours: 72 },
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
    breachNotify: { kind: "no-fixed-period" },
    officerRequired: true,
    officerTitle: "Information Officer",
    modelled: true,
    note: "POPIA requires notification as soon as reasonably possible after discovery — there is no fixed hour count. An Information Officer is mandatory and registered with the Regulator.",
  },
  GH_DPA: {
    key: "GH_DPA",
    label: "Ghana Data Protection Act 2012",
    authority: "the Data Protection Commission",
    breachNotify: { kind: "no-fixed-period" },
    officerRequired: true,
    officerTitle: "Data Protection Supervisor",
    modelled: true,
    note: "Notification is required as soon as reasonably practicable; data controllers register with the Commission.",
  },

  // ---------------------------------------------------------------------------
  // The rest of Africa
  // ---------------------------------------------------------------------------
  // Naming the LAW and the REGULATOR is the high-value, low-risk half: it tells a
  // school in Kampala or Dakar that it has obligations and who supervises them,
  // which is what changes behaviour. The notification DEADLINE is the half a
  // wrong answer does real damage on, so it is `unknown` throughout below unless
  // stated otherwise — the register still runs its 72-hour target, labelled as
  // practice, and the note tells them to confirm the statutory window.
  //
  // Countries deliberately NOT listed (Namibia, Liberia, The Gambia, Cameroon,
  // Sierra Leone) stay UNSPECIFIED: a comprehensive statute in force could not be
  // established, and asserting one is the same class of error as asserting none.
  ET_PDPP: {
    key: "ET_PDPP", label: "Ethiopia Personal Data Protection Proclamation 1321/2024",
    authority: "the designated supervisory authority",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "The Personal Data Protection Proclamation No. 1321/2024 applies. It is recent — confirm the supervising authority and the notification window locally.",
  },
  UG_DPPA: {
    key: "UG_DPPA", label: "Uganda Data Protection and Privacy Act 2019",
    authority: "the Personal Data Protection Office",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "The Data Protection and Privacy Act 2019 applies, supervised by the Personal Data Protection Office. Controllers register with the Office. Confirm the breach-notification window — this platform does not model it.",
  },
  TZ_PDPA: {
    key: "TZ_PDPA", label: "Tanzania Personal Data Protection Act 2022",
    authority: "the Personal Data Protection Commission",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "The Personal Data Protection Act 2022 applies, supervised by the Personal Data Protection Commission, with registration of controllers. Confirm the breach-notification window.",
  },
  RW_DPL: {
    key: "RW_DPL", label: "Rwanda Law No. 058/2021 on personal data",
    authority: "the National Cyber Security Authority",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "Law No. 058/2021 applies, supervised by the National Cyber Security Authority. Its notification window is shorter than the 72 hours shown as a target here — confirm it before relying on the countdown.",
  },
  ZM_DPA: {
    key: "ZM_DPA", label: "Zambia Data Protection Act 2021",
    authority: "the Data Protection Commissioner",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "The Data Protection Act 2021 applies, supervised by the Data Protection Commissioner. Confirm the breach-notification window.",
  },
  ZW_CDPA: {
    key: "ZW_CDPA", label: "Zimbabwe Cyber and Data Protection Act 2021",
    authority: "POTRAZ, as Data Protection Authority",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "The Cyber and Data Protection Act 2021 applies, with POTRAZ as the Data Protection Authority and licensing of controllers. Confirm the breach-notification window.",
  },
  BW_DPA: {
    key: "BW_DPA", label: "Botswana Data Protection Act 2018",
    authority: "the Information and Data Protection Commission",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "The Data Protection Act 2018 applies, supervised by the Information and Data Protection Commission. Confirm the breach-notification window.",
  },
  MW_DPA: {
    key: "MW_DPA", label: "Malawi Data Protection Act 2024",
    authority: "the designated data protection authority",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "The Data Protection Act 2024 applies. It is recent — confirm both the supervising authority and the breach-notification window locally.",
  },
  EG_PDPL: {
    key: "EG_PDPL", label: "Egypt Personal Data Protection Law 151/2020",
    authority: "the Personal Data Protection Centre",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "Law No. 151 of 2020 applies, supervised by the Personal Data Protection Centre, with licensing and a designated officer. Confirm the breach-notification window.",
  },
  MA_0908: {
    key: "MA_0908", label: "Morocco Law 09-08",
    authority: "the CNDP",
    breachNotify: { kind: "unknown" }, officerRequired: false,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "Law 09-08 applies, supervised by the CNDP. It is built on DECLARATION of processing to the CNDP rather than on an internal officer — no officer requirement does not mean no obligation. Confirm the breach-notification window.",
  },
  TN_2004: {
    key: "TN_2004", label: "Tunisia Law 2004-63",
    authority: "the INPDP",
    breachNotify: { kind: "unknown" }, officerRequired: false,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "Law 2004-63 applies, supervised by the INPDP, and is built on declaration and authorisation rather than an internal officer. Processing children's data attracts additional requirements. Confirm the breach-notification window.",
  },
  SN_2008: {
    key: "SN_2008", label: "Senegal Law 2008-12",
    authority: "the Commission de Protection des Données Personnelles",
    breachNotify: { kind: "unknown" }, officerRequired: false,
    officerTitle: "Correspondant à la protection des données", modelled: true,
    note: "Law 2008-12 applies, supervised by the CDP, and is built on declaration to the Commission rather than a mandatory internal officer. Confirm the breach-notification window.",
  },
  CI_2013: {
    key: "CI_2013", label: "Côte d'Ivoire Law 2013-450",
    authority: "the ARTCI",
    breachNotify: { kind: "unknown" }, officerRequired: false,
    officerTitle: "Correspondant à la protection des données", modelled: true,
    note: "Law 2013-450 applies, supervised by the ARTCI, with declaration of processing to the authority. Confirm the breach-notification window.",
  },
  ML_2013: {
    key: "ML_2013", label: "Mali Law 2013-015",
    authority: "the APDP",
    breachNotify: { kind: "unknown" }, officerRequired: false,
    officerTitle: "Correspondant à la protection des données", modelled: true,
    note: "Law 2013-015 applies, supervised by the APDP, with declaration of processing to the authority. Confirm the breach-notification window.",
  },
  BJ_CODE: {
    key: "BJ_CODE", label: "Benin Digital Code (Book V)",
    authority: "the APDP",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "The Digital Code's personal-data provisions apply, supervised by the APDP. Confirm the breach-notification window.",
  },
  BF_2004: {
    key: "BF_2004", label: "Burkina Faso Law 010-2004",
    authority: "the Commission de l'Informatique et des Libertés",
    breachNotify: { kind: "unknown" }, officerRequired: false,
    officerTitle: "Correspondant à la protection des données", modelled: true,
    note: "Law 010-2004 applies, supervised by the CIL, and is built on declaration of processing rather than a mandatory internal officer. Confirm the breach-notification window.",
  },
  TG_2019: {
    key: "TG_2019", label: "Togo Law 2019-014",
    authority: "the Instance de Protection des Données à Caractère Personnel",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "Law 2019-014 applies, supervised by the IPDCP. Confirm the breach-notification window.",
  },
  NE_2017: {
    key: "NE_2017", label: "Niger Law 2017-28",
    authority: "the Haute Autorité de Protection des Données à Caractère Personnel",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "Law 2017-28 applies, supervised by the HAPDP. Confirm the breach-notification window.",
  },
  GA_2011: {
    key: "GA_2011", label: "Gabon Law 001/2011",
    authority: "the CNPDCP",
    breachNotify: { kind: "unknown" }, officerRequired: false,
    officerTitle: "Correspondant à la protection des données", modelled: true,
    note: "Law 001/2011 applies, supervised by the CNPDCP, with declaration of processing to the authority. Confirm the breach-notification window.",
  },
  CD_CODE: {
    key: "CD_CODE", label: "DR Congo Digital Code 2023",
    authority: "the authority designated under the Digital Code",
    breachNotify: { kind: "unknown" }, officerRequired: true,
    officerTitle: "Data Protection Officer", modelled: true,
    note: "The Digital Code of 2023 carries personal-data obligations. It is recent — confirm the supervising authority and the notification window locally.",
  },
  UNSPECIFIED: {
    key: "UNSPECIFIED",
    label: "Not modelled for this country",
    authority: null,
    breachNotify: { kind: "unknown" },
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
  // Only a named statutory period is `statutory`. Both "no fixed period" and
  // "we have not established it" fall back to the good-practice target, which
  // the screen labels as practice — so neither is ever shown as the law.
  return p.breachNotify.kind === "hours"
    ? { hours: p.breachNotify.hours, statutory: true }
    : { hours: DEFAULT_BREACH_TARGET_HOURS, statutory: false };
}

/** Why the target is not statutory, so the screen can word it. */
export function breachDeadlineBasis(key: string | null | undefined): "statutory" | "no-fixed-period" | "unknown" {
  const k = complianceProfile(key).breachNotify.kind;
  return k === "hours" ? "statutory" : k === "no-fixed-period" ? "no-fixed-period" : "unknown";
}
