// =============================================================================
// Subject catalogue — a starting list, per curriculum, per stage
// =============================================================================
// A school sets up by typing its subjects in free text. That works, and it costs
// every new school twenty minutes of typing and produces "Maths", "Mathematics"
// and "MATHS" across three schools — after which no cross-school question can be
// asked, and a transferring pupil's record cannot be lined up with their new
// school's.
//
// So this is the list they pick from. Three rules shape it:
//
// 1. IT IS A TEMPLATE, COPIED — NEVER A SHARED ROW.
//    Picking an entry INSERTS a tenant-scoped `subject` row with its own uuid,
//    exactly as typing the name does today. A global table that
//    `class_subject_teacher.subjectId` pointed at would have no `school_id` for
//    RLS to scope, would let one school's rename change another's report cards,
//    and would let a catalogue edit ripple into live timetables.
//
// 2. THE CONCEPT CODE IS WHAT MAKES THEM COMPARABLE.
//    Copies alone lose the link. Each row keeps `catalogueCode` — the CONCEPT,
//    not the school's wording — so a Senegalese "Mathématiques" and a Nigerian
//    "Mathematics" both carry MTH and can be compared, while either school
//    remains free to rename its own copy to anything. Custom subjects carry
//    null, which is a first-class state, not a gap.
//
// 3. THE LIST FOLLOWS THE REGION, like calendar templates and payroll packs.
//    Offering "English Language" to a school in Dakar is worse than offering
//    nothing, because people accept defaults. A francophone school is offered
//    Français, Mathématiques, Histoire-Géographie.
//
// Coverage is deliberately broad — pre-primary through senior secondary,
// including the science/arts/commercial/vocational streams a senior school
// actually has to timetable. A list that stops at the core ten sends everyone
// back to free text for exactly the subjects that vary most.
// =============================================================================

export const SUBJECT_STAGES = ["PRE_PRIMARY", "PRIMARY", "JUNIOR_SECONDARY", "SENIOR_SECONDARY"] as const;
export type SubjectStage = (typeof SUBJECT_STAGES)[number];

export const SUBJECT_STAGE_LABELS: Record<SubjectStage, string> = {
  PRE_PRIMARY: "Pre-primary",
  PRIMARY: "Primary",
  JUNIOR_SECONDARY: "Junior secondary",
  SENIOR_SECONDARY: "Senior secondary",
};

/** Broad grouping, so a senior-school picker can be read in streams rather than
 *  as one alphabetical wall of eighty entries. */
export const SUBJECT_GROUPS = [
  "Core",
  "Languages",
  "Sciences",
  "Humanities",
  "Commercial",
  "Technology",
  "Arts",
  "Vocational",
  "Religious",
  "Wellbeing",
] as const;
export type SubjectGroup = (typeof SUBJECT_GROUPS)[number];

/**
 * The CONCEPT registry: a stable code and its canonical English name.
 *
 * This is the comparability key and the single source of truth for what a code
 * means. A catalogue entry references a code and may override the DISPLAY name
 * for its language — the concept underneath is unchanged, which is the whole
 * point: "Mathématiques" and "Mathematics" are one row in any cross-school
 * report because both carry MTH.
 */
export const SUBJECT_CONCEPTS: Record<string, string> = {
  // --- core ---------------------------------------------------------------
  ENG: "English Language",
  ENGLIT: "Literature in English",
  ENGSTU: "English Studies",
  ELA: "English Language Arts",
  MTH: "Mathematics",
  FMTH: "Further Mathematics",
  MTHLIT: "Mathematical Literacy",
  GENMTH: "General Mathematics",
  // --- languages ----------------------------------------------------------
  FRE: "French",
  SPA: "Spanish",
  GER: "German",
  ARA: "Arabic",
  POR: "Portuguese",
  PHIL: "Philosophy",
  KIS: "Kiswahili",
  YOR: "Yoruba",
  IGB: "Igbo",
  HAU: "Hausa",
  NGLANG: "Nigerian Language",
  HOMELANG: "Home Language",
  FAL: "First Additional Language",
  LIT: "Literature",
  // --- sciences -----------------------------------------------------------
  BASSCI: "Basic Science",
  SCI: "Science",
  INTSCI: "Integrated Science",
  PHY: "Physics",
  CHE: "Chemistry",
  BIO: "Biology",
  COMBSCI: "Combined Science",
  PHYSCI: "Physical Sciences",
  LIFESCI: "Life Sciences",
  NATSCI: "Natural Sciences",
  AGR: "Agricultural Science",
  ENVSCI: "Environmental Science",
  SVT: "Life and Earth Sciences",
  PHYCHEM: "Physics and Chemistry",
  HEASCI: "Health Science",
  // --- humanities ---------------------------------------------------------
  SOC: "Social Studies",
  HIS: "History",
  GEO: "Geography",
  HISGEO: "History and Geography",
  GOV: "Government",
  CIV: "Civic Education",
  SOCSCI: "Social Sciences",
  SOCIO: "Sociology",
  PSY: "Psychology",
  ECON: "Economics",
  SES: "Economics and Social Sciences",
  // --- commercial ---------------------------------------------------------
  BUS: "Business Studies",
  COM: "Commerce",
  ACC: "Accounting",
  BKP: "Book-Keeping",
  OFFP: "Office Practice",
  INS: "Insurance",
  EMS: "Economic and Management Sciences",
  MKT: "Marketing",
  // --- technology ---------------------------------------------------------
  ICT: "Information and Communication Technology",
  COMP: "Computer Studies",
  CS: "Computer Science",
  DATA: "Data Processing",
  BASTEC: "Basic Technology",
  TECH: "Technology",
  TD: "Technical Drawing",
  DT: "Design and Technology",
  EGD: "Engineering Graphics and Design",
  CAT: "Computer Applications Technology",
  PRETECH: "Pre-Technical Studies",
  // --- arts ---------------------------------------------------------------
  CCA: "Cultural and Creative Arts",
  ART: "Visual Arts",
  MUS: "Music",
  DRA: "Drama",
  PERF: "Performing Arts",
  CREATE: "Creative Arts",
  MEDIA: "Media Studies",
  // --- vocational ---------------------------------------------------------
  HEC: "Home Economics",
  HOMESCI: "Home Science",
  PREVOC: "Pre-Vocational Studies",
  CATER: "Catering Craft Practice",
  GARM: "Garment Making",
  AUTO: "Auto Mechanics",
  ELEC: "Electrical Installation",
  BLOCK: "Block Laying and Concreting",
  WELD: "Welding and Fabrication",
  PAINT: "Painting and Decorating",
  COSM: "Cosmetology",
  PHOTO: "Photography",
  GSM: "GSM Maintenance and Repairs",
  ANIM: "Animal Husbandry",
  FISH: "Fisheries",
  TOUR: "Tourism",
  CONS: "Consumer Studies",
  // --- religious ----------------------------------------------------------
  CRS: "Christian Religious Studies",
  IRS: "Islamic Religious Studies",
  RE: "Religious Education",
  HRE: "Hindu Religious Education",
  MORAL: "Moral and Civic Education",
  // --- wellbeing ----------------------------------------------------------
  PHE: "Physical and Health Education",
  PE: "Physical Education",
  HEALTH: "Health Education",
  LIFESK: "Life Skills",
  LO: "Life Orientation",
  PSHE: "Personal, Social and Health Education",
  SEC: "Security Education",
  GUID: "Guidance and Counselling",
  HANDW: "Handwriting",
  REASON: "Verbal and Quantitative Reasoning",
};

export interface CatalogueSubject {
  /** A key of SUBJECT_CONCEPTS. The comparability anchor. */
  code: string;
  /** Display name in this curriculum's language. Defaults to the concept name. */
  name?: string;
  stages: readonly SubjectStage[];
  group: SubjectGroup;
}

const ALL_SEC = ["JUNIOR_SECONDARY", "SENIOR_SECONDARY"] as const;
const PRI_JSS = ["PRIMARY", "JUNIOR_SECONDARY"] as const;
const EVERY = ["PRE_PRIMARY", "PRIMARY", "JUNIOR_SECONDARY", "SENIOR_SECONDARY"] as const;

/**
 * Curricula. A country maps to one of these; several share.
 *
 * Names are given ONLY where they differ from the concept's canonical English —
 * so the francophone list carries French names and the English lists inherit,
 * which halves the authoring and keeps the concept the single source of truth.
 */
export const SUBJECT_CATALOGUES: Record<string, { key: string; label: string; subjects: readonly CatalogueSubject[] }> = {
  // ---------------------------------------------------------------------------
  NG: {
    key: "NG",
    label: "Nigeria (UBE / BECE / WASSCE)",
    subjects: [
      { code: "ENGSTU", stages: PRI_JSS, group: "Core" },
      { code: "ENG", stages: ["SENIOR_SECONDARY"], group: "Core" },
      { code: "MTH", stages: EVERY, group: "Core" },
      { code: "REASON", stages: ["PRE_PRIMARY", "PRIMARY"], group: "Wellbeing" },
      { code: "HANDW", stages: ["PRE_PRIMARY", "PRIMARY"], group: "Wellbeing" },
      { code: "BASSCI", name: "Basic Science and Technology", stages: PRI_JSS, group: "Sciences" },
      { code: "BASTEC", stages: ["JUNIOR_SECONDARY"], group: "Technology" },
      { code: "SOC", stages: PRI_JSS, group: "Humanities" },
      { code: "CIV", name: "National Values / Civic Education", stages: EVERY, group: "Humanities" },
      { code: "SEC", stages: PRI_JSS, group: "Wellbeing" },
      { code: "CCA", stages: PRI_JSS, group: "Arts" },
      { code: "NGLANG", stages: EVERY, group: "Languages" },
      { code: "YOR", stages: ALL_SEC, group: "Languages" },
      { code: "IGB", stages: ALL_SEC, group: "Languages" },
      { code: "HAU", stages: ALL_SEC, group: "Languages" },
      { code: "FRE", stages: EVERY, group: "Languages" },
      { code: "ARA", stages: ALL_SEC, group: "Languages" },
      { code: "CRS", stages: EVERY, group: "Religious" },
      { code: "IRS", stages: EVERY, group: "Religious" },
      { code: "PHE", stages: EVERY, group: "Wellbeing" },
      { code: "PREVOC", stages: PRI_JSS, group: "Vocational" },
      { code: "AGR", stages: ALL_SEC, group: "Sciences" },
      { code: "HEC", stages: ALL_SEC, group: "Vocational" },
      { code: "BUS", stages: ["JUNIOR_SECONDARY"], group: "Commercial" },
      { code: "COMP", name: "Computer Studies / ICT", stages: EVERY, group: "Technology" },
      { code: "HIS", stages: ALL_SEC, group: "Humanities" },
      // senior — sciences
      { code: "PHY", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "CHE", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "BIO", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "FMTH", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "TD", stages: ["SENIOR_SECONDARY"], group: "Technology" },
      { code: "HEASCI", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      // senior — arts / humanities
      { code: "ENGLIT", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "GOV", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "GEO", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "ECON", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "ART", stages: ALL_SEC, group: "Arts" },
      { code: "MUS", stages: ALL_SEC, group: "Arts" },
      // senior — commercial
      { code: "ACC", name: "Financial Accounting", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "COM", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "BKP", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "OFFP", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "INS", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "DATA", stages: ["SENIOR_SECONDARY"], group: "Technology" },
      // senior — trade / vocational (WASSCE trade subjects)
      { code: "AUTO", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "ELEC", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "CATER", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "GARM", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "BLOCK", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "WELD", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "PAINT", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "COSM", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "PHOTO", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "GSM", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "ANIM", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "FISH", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
    ],
  },

  // ---------------------------------------------------------------------------
  FR: {
    key: "FR",
    label: "Programme francophone (Primaire / Collège / Lycée)",
    subjects: [
      { code: "FRE", name: "Français", stages: EVERY, group: "Core" },
      { code: "MTH", name: "Mathématiques", stages: EVERY, group: "Core" },
      { code: "ENG", name: "Anglais", stages: EVERY, group: "Languages" },
      { code: "SCI", name: "Éveil scientifique", stages: ["PRE_PRIMARY", "PRIMARY"], group: "Sciences" },
      { code: "SVT", name: "Sciences de la Vie et de la Terre", stages: ALL_SEC, group: "Sciences" },
      { code: "PHYCHEM", name: "Physique-Chimie", stages: ALL_SEC, group: "Sciences" },
      { code: "PHY", name: "Physique", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "CHE", name: "Chimie", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "BIO", name: "Biologie", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "HISGEO", name: "Histoire-Géographie", stages: EVERY, group: "Humanities" },
      { code: "MORAL", name: "Éducation civique et morale", stages: EVERY, group: "Humanities" },
      { code: "PHIL", name: "Philosophie", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "LIT", name: "Littérature", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "SES", name: "Sciences économiques et sociales", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "ECON", name: "Économie", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "ACC", name: "Comptabilité", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "SPA", name: "Espagnol", stages: ALL_SEC, group: "Languages" },
      { code: "GER", name: "Allemand", stages: ALL_SEC, group: "Languages" },
      { code: "ARA", name: "Arabe", stages: EVERY, group: "Languages" },
      { code: "ART", name: "Arts plastiques", stages: EVERY, group: "Arts" },
      { code: "MUS", name: "Musique / Chant", stages: EVERY, group: "Arts" },
      { code: "PE", name: "Éducation physique et sportive", stages: EVERY, group: "Wellbeing" },
      { code: "ICT", name: "Informatique", stages: EVERY, group: "Technology" },
      { code: "TECH", name: "Technologie", stages: ALL_SEC, group: "Technology" },
      { code: "RE", name: "Éducation religieuse", stages: EVERY, group: "Religious" },
      { code: "AGR", name: "Agriculture", stages: ALL_SEC, group: "Sciences" },
      { code: "HEC", name: "Économie familiale", stages: ALL_SEC, group: "Vocational" },
    ],
  },

  // ---------------------------------------------------------------------------
  GB: {
    key: "GB",
    label: "England and Wales (Key Stages / GCSE)",
    subjects: [
      { code: "ENG", stages: PRI_JSS, group: "Core" },
      { code: "ENGLIT", name: "English Literature", stages: ["SENIOR_SECONDARY"], group: "Core" },
      { code: "MTH", stages: EVERY, group: "Core" },
      { code: "FMTH", stages: ["SENIOR_SECONDARY"], group: "Core" },
      { code: "SCI", stages: PRI_JSS, group: "Sciences" },
      { code: "COMBSCI", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "BIO", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "CHE", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "PHY", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "HIS", stages: EVERY, group: "Humanities" },
      { code: "GEO", stages: EVERY, group: "Humanities" },
      { code: "SOCIO", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "PSY", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "ECON", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "BUS", stages: ALL_SEC, group: "Commercial" },
      { code: "FRE", stages: EVERY, group: "Languages" },
      { code: "SPA", stages: EVERY, group: "Languages" },
      { code: "GER", stages: ALL_SEC, group: "Languages" },
      { code: "CS", stages: ALL_SEC, group: "Technology" },
      { code: "ICT", name: "Computing", stages: EVERY, group: "Technology" },
      { code: "DT", stages: EVERY, group: "Technology" },
      { code: "ART", name: "Art and Design", stages: EVERY, group: "Arts" },
      { code: "MUS", stages: EVERY, group: "Arts" },
      { code: "DRA", stages: ALL_SEC, group: "Arts" },
      { code: "MEDIA", stages: ["SENIOR_SECONDARY"], group: "Arts" },
      { code: "RE", stages: EVERY, group: "Religious" },
      { code: "PE", stages: EVERY, group: "Wellbeing" },
      { code: "PSHE", stages: EVERY, group: "Wellbeing" },
      { code: "CIV", name: "Citizenship", stages: ALL_SEC, group: "Humanities" },
    ],
  },

  // ---------------------------------------------------------------------------
  ZA: {
    key: "ZA",
    label: "South Africa (CAPS)",
    subjects: [
      { code: "HOMELANG", stages: EVERY, group: "Core" },
      { code: "FAL", stages: EVERY, group: "Core" },
      { code: "MTH", stages: EVERY, group: "Core" },
      { code: "MTHLIT", stages: ["SENIOR_SECONDARY"], group: "Core" },
      { code: "LIFESK", name: "Life Skills", stages: ["PRE_PRIMARY", "PRIMARY"], group: "Wellbeing" },
      { code: "LO", stages: ALL_SEC, group: "Wellbeing" },
      { code: "NATSCI", name: "Natural Sciences and Technology", stages: PRI_JSS, group: "Sciences" },
      { code: "PHYSCI", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "LIFESCI", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "AGR", name: "Agricultural Sciences", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "SOCSCI", stages: PRI_JSS, group: "Humanities" },
      { code: "HIS", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "GEO", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "EMS", stages: ["JUNIOR_SECONDARY"], group: "Commercial" },
      { code: "ACC", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "BUS", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "ECON", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "TECH", stages: ["JUNIOR_SECONDARY"], group: "Technology" },
      { code: "CAT", stages: ["SENIOR_SECONDARY"], group: "Technology" },
      { code: "CS", name: "Information Technology", stages: ["SENIOR_SECONDARY"], group: "Technology" },
      { code: "EGD", stages: ["SENIOR_SECONDARY"], group: "Technology" },
      { code: "CREATE", stages: ["JUNIOR_SECONDARY"], group: "Arts" },
      { code: "ART", stages: ["SENIOR_SECONDARY"], group: "Arts" },
      { code: "DRA", name: "Dramatic Arts", stages: ["SENIOR_SECONDARY"], group: "Arts" },
      { code: "MUS", stages: ["SENIOR_SECONDARY"], group: "Arts" },
      { code: "CONS", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
      { code: "TOUR", stages: ["SENIOR_SECONDARY"], group: "Vocational" },
    ],
  },

  // ---------------------------------------------------------------------------
  KE: {
    key: "KE",
    label: "Kenya (CBC)",
    subjects: [
      { code: "ENG", stages: EVERY, group: "Core" },
      { code: "KIS", stages: EVERY, group: "Core" },
      { code: "MTH", stages: EVERY, group: "Core" },
      { code: "SCI", name: "Science and Technology", stages: ["PRIMARY"], group: "Sciences" },
      { code: "INTSCI", stages: ["JUNIOR_SECONDARY"], group: "Sciences" },
      { code: "BIO", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "CHE", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "PHY", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "AGR", name: "Agriculture", stages: PRI_JSS, group: "Sciences" },
      { code: "SOC", stages: PRI_JSS, group: "Humanities" },
      { code: "HIS", name: "History and Government", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "GEO", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "RE", name: "Religious Education (CRE / IRE / HRE)", stages: EVERY, group: "Religious" },
      { code: "BUS", stages: ALL_SEC, group: "Commercial" },
      { code: "PRETECH", name: "Pre-Technical and Pre-Career Education", stages: ["JUNIOR_SECONDARY"], group: "Technology" },
      { code: "CS", name: "Computer Science", stages: ALL_SEC, group: "Technology" },
      { code: "CREATE", name: "Creative Arts", stages: PRI_JSS, group: "Arts" },
      { code: "ART", name: "Art and Design", stages: ["SENIOR_SECONDARY"], group: "Arts" },
      { code: "PERF", stages: ["JUNIOR_SECONDARY"], group: "Arts" },
      { code: "MUS", stages: ["SENIOR_SECONDARY"], group: "Arts" },
      { code: "HOMESCI", stages: ALL_SEC, group: "Vocational" },
      { code: "PHE", name: "Sports and Physical Education", stages: EVERY, group: "Wellbeing" },
      { code: "HEALTH", stages: ["JUNIOR_SECONDARY"], group: "Wellbeing" },
      { code: "LIFESK", stages: PRI_JSS, group: "Wellbeing" },
      { code: "FRE", stages: ALL_SEC, group: "Languages" },
      { code: "GER", stages: ALL_SEC, group: "Languages" },
      { code: "ARA", stages: ALL_SEC, group: "Languages" },
    ],
  },

  // ---------------------------------------------------------------------------
  US: {
    key: "US",
    label: "United States (K-12)",
    subjects: [
      { code: "ELA", stages: EVERY, group: "Core" },
      { code: "MTH", stages: EVERY, group: "Core" },
      { code: "GENMTH", name: "Algebra", stages: ["SENIOR_SECONDARY"], group: "Core" },
      { code: "SCI", stages: PRI_JSS, group: "Sciences" },
      { code: "BIO", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "CHE", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "PHY", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "ENVSCI", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "SOC", name: "Social Studies", stages: PRI_JSS, group: "Humanities" },
      { code: "HIS", stages: ALL_SEC, group: "Humanities" },
      { code: "GOV", stages: ["SENIOR_SECONDARY"], group: "Humanities" },
      { code: "GEO", stages: ALL_SEC, group: "Humanities" },
      { code: "ECON", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "BUS", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "SPA", stages: EVERY, group: "Languages" },
      { code: "FRE", stages: EVERY, group: "Languages" },
      { code: "CS", stages: ALL_SEC, group: "Technology" },
      { code: "ART", name: "Art", stages: EVERY, group: "Arts" },
      { code: "MUS", stages: EVERY, group: "Arts" },
      { code: "DRA", stages: ALL_SEC, group: "Arts" },
      { code: "PE", stages: EVERY, group: "Wellbeing" },
      { code: "HEALTH", stages: EVERY, group: "Wellbeing" },
    ],
  },

  // ---------------------------------------------------------------------------
  INTL: {
    key: "INTL",
    label: "General / international",
    subjects: [
      { code: "ENG", stages: EVERY, group: "Core" },
      { code: "MTH", stages: EVERY, group: "Core" },
      { code: "SCI", stages: PRI_JSS, group: "Sciences" },
      { code: "BIO", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "CHE", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "PHY", stages: ["SENIOR_SECONDARY"], group: "Sciences" },
      { code: "HIS", stages: ALL_SEC, group: "Humanities" },
      { code: "GEO", stages: ALL_SEC, group: "Humanities" },
      { code: "SOC", stages: PRI_JSS, group: "Humanities" },
      { code: "ECON", stages: ["SENIOR_SECONDARY"], group: "Commercial" },
      { code: "BUS", stages: ALL_SEC, group: "Commercial" },
      { code: "ICT", stages: EVERY, group: "Technology" },
      { code: "CS", stages: ALL_SEC, group: "Technology" },
      { code: "ART", stages: EVERY, group: "Arts" },
      { code: "MUS", stages: EVERY, group: "Arts" },
      { code: "PE", stages: EVERY, group: "Wellbeing" },
      { code: "RE", stages: EVERY, group: "Religious" },
      { code: "FRE", stages: EVERY, group: "Languages" },
    ],
  },
};

/** Which curriculum a country follows. Unlisted countries get INTL, which is a
 *  usable list rather than an empty one — a school with no catalogue is back to
 *  typing everything by hand, which is the problem this exists to solve. */
const COUNTRY_CURRICULUM: Record<string, string> = {
  NG: "NG",
  GB: "GB", IE: "GB", GH: "GB", KE: "KE", ZA: "ZA", US: "US", CA: "US",
  UG: "GB", TZ: "GB", ZM: "GB", ZW: "GB", BW: "GB", NA: "GB", MW: "GB",
  SL: "GB", LR: "GB", GM: "GB", RW: "GB", ET: "INTL",
  SN: "FR", CI: "FR", ML: "FR", BJ: "FR", BF: "FR", TG: "FR", NE: "FR",
  CM: "FR", GA: "FR", CD: "FR", MA: "FR", TN: "FR",
  EG: "INTL", AE: "INTL", SA: "INTL", IN: "INTL", SG: "GB",
};

export const DEFAULT_CURRICULUM = "INTL";

export function curriculumForCountry(country: string | null | undefined): string {
  return COUNTRY_CURRICULUM[(country ?? "").toUpperCase()] ?? DEFAULT_CURRICULUM;
}

/** The display name for a catalogue entry: its own, else the concept's. */
export function catalogueSubjectName(s: CatalogueSubject): string {
  return s.name ?? SUBJECT_CONCEPTS[s.code] ?? s.code;
}

/**
 * The list a school should be offered, optionally narrowed to one stage.
 *
 * Sorted by group then name so the picker reads in streams — eighty entries in
 * one alphabetical column is a list nobody finishes.
 */
export function subjectCatalogueFor(
  country: string | null | undefined,
  stage?: SubjectStage,
): Array<CatalogueSubject & { displayName: string; curriculum: string }> {
  const key = curriculumForCountry(country);
  const cat = SUBJECT_CATALOGUES[key] ?? SUBJECT_CATALOGUES[DEFAULT_CURRICULUM];
  return cat.subjects
    .filter((s) => !stage || s.stages.includes(stage))
    .map((s) => ({ ...s, displayName: catalogueSubjectName(s), curriculum: cat.key }))
    .sort((a, b) => SUBJECT_GROUPS.indexOf(a.group) - SUBJECT_GROUPS.indexOf(b.group) || a.displayName.localeCompare(b.displayName));
}

/**
 * The catalogue concept a scholarship category corresponds to, if any.
 *
 * The scholarship exam pipeline has to name a real Subject in each school —
 * teacher access to a question bank is decided by subject. It used to match on
 * the exact name and create one on a miss, which splits a school's subject in
 * two the moment its wording differs: a francophone school holding
 * "Mathématiques" got a second "Mathematics", after which grades for one subject
 * land under two ids and the report card shows half of them.
 *
 * Returning null is a real answer: COMMUNITY_DEVELOPMENT and SPECIAL are not
 * school subjects, so those fall back to name matching and stay custom.
 */
export function scholarshipSubjectConcept(category: string): string | null {
  switch (category) {
    case "MATHEMATICS":
      return "MTH";
    case "GENERAL_SCIENCE":
      return "SCI";
    case "ART":
      return "ART";
    default:
      return null;
  }
}
