// =============================================================================
// SIS — permission constants (single source of truth)
// =============================================================================
// Coarse permissions gate the ENDPOINTS; relationship scoping (teacher-of-
// student / parent-of-child / self / school staff) narrows the ROWS in
// SisService, backstopped by RLS. Holding `student.profile.read` does NOT mean
// a teacher can read every student — only their own students.
//
// Medical permissions are the MOST restricted (Golden Rule #7): write is
// school staff only; read is school staff + the student's own guardians. Every
// medical read AND write is audit-logged in the service (Golden Rule #5).
// =============================================================================

export const SIS_PERMISSIONS = {
  /** Read a student's demographic/contact profile (rows scoped by relationship). */
  STUDENT_PROFILE_READ: "student.profile.read",
  /** Create/edit a student's profile. principal, school_admin. */
  STUDENT_PROFILE_WRITE: "student.profile.write",

  /** Read a student's emergency contacts (rows scoped by relationship). */
  STUDENT_CONTACT_READ: "student.contact.read",
  /** Add/edit/remove emergency contacts. principal, school_admin. */
  STUDENT_CONTACT_WRITE: "student.contact.write",

  /** Read a student's medical record. School staff + the student's guardians. */
  STUDENT_MEDICAL_READ: "student.medical.read",
  /** Create/edit a student's medical record. School staff only. */
  STUDENT_MEDICAL_WRITE: "student.medical.write",

  /** Stage / approve a bulk SIS student import (maker-checker: a DIFFERENT person
   *  approves). principal, school_admin, hr_manager, hr_clerk. */
  STUDENT_IMPORT: "student.import",

  /** The consolidated "my children" overview (grades / attendance / discipline /
   *  tasks / fees for LINKED children only — ParentChild-scoped). parent. */
  FAMILY_READ: "family.read",

  /** Onboard PARENT/guardian accounts — single create or bulk upload (maker-
   *  checker: a DIFFERENT person approves a bulk batch). Generated logins +
   *  ParentChild links. principal, school_admin, hr_manager, hr_clerk. */
  PARENT_IMPORT: "parent.import",
} as const;

export type SisPermission = (typeof SIS_PERMISSIONS)[keyof typeof SIS_PERMISSIONS];

/** Suggested role -> permission additions (spread into the foundation mapping).
 *  Teachers deliberately do NOT get medical read by default — it is the most
 *  sensitive PII; grant via a dedicated nurse role when one exists. */
export const SIS_ROLE_PERMISSIONS = {
  principal: [
    SIS_PERMISSIONS.STUDENT_PROFILE_READ,
    SIS_PERMISSIONS.STUDENT_PROFILE_WRITE,
    SIS_PERMISSIONS.STUDENT_CONTACT_READ,
    SIS_PERMISSIONS.STUDENT_CONTACT_WRITE,
    SIS_PERMISSIONS.STUDENT_MEDICAL_READ,
    SIS_PERMISSIONS.STUDENT_MEDICAL_WRITE,
  ],
  school_admin: [
    SIS_PERMISSIONS.STUDENT_PROFILE_READ,
    SIS_PERMISSIONS.STUDENT_PROFILE_WRITE,
    SIS_PERMISSIONS.STUDENT_CONTACT_READ,
    SIS_PERMISSIONS.STUDENT_CONTACT_WRITE,
    SIS_PERMISSIONS.STUDENT_MEDICAL_READ,
    SIS_PERMISSIONS.STUDENT_MEDICAL_WRITE,
  ],
  teacher: [
    SIS_PERMISSIONS.STUDENT_PROFILE_READ,
    SIS_PERMISSIONS.STUDENT_CONTACT_READ,
  ],
  parent: [
    SIS_PERMISSIONS.STUDENT_PROFILE_READ,
    SIS_PERMISSIONS.STUDENT_CONTACT_READ,
    SIS_PERMISSIONS.STUDENT_MEDICAL_READ,
  ],
  student: [SIS_PERMISSIONS.STUDENT_PROFILE_READ],
} as const;
