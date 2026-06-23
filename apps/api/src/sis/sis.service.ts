// =============================================================================
// SisService — student profile, emergency contacts, medical record
// =============================================================================
// Coarse permissions gate the endpoints; this service narrows ROWS by
// relationship (same RBAC-beyond-role model as the LMS, CLAUDE.md):
//   - school staff (school_admin / principal / super_admin) -> any student in tenant
//   - teacher -> students enrolled in a class they teach
//   - parent  -> their own children (parent_child)
//   - student -> themselves
// Everything runs inside a tenant transaction (RLS-enforced). Not-visible -> 404
// (never 403), no cross-tenant/relationship leak.
//
// Golden Rule #5: the MEDICAL record is the most sensitive minors' PII — every
// medical READ and WRITE is audit-logged here (not just writes), so access is
// always accountable. Golden Rule #8: this is a record for human care, never an
// automated judgement; no scores or flags are derived.
// =============================================================================

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { decryptField, encryptField } from "../foundation/field-crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal", "super_admin"]);

export interface ProfileInput {
  admissionNumber?: string | null;
  dateOfBirth?: string | null; // ISO date (YYYY-MM-DD)
  gender?: string | null;
  phone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postalCode?: string | null;
  notes?: string | null;
}

export interface ContactInput {
  name: string;
  relationship: string;
  phone: string;
  email?: string | null;
  priority?: number;
}

export interface MedicalInput {
  bloodGroup?: string | null;
  allergies?: string | null;
  conditions?: string | null;
  medications?: string | null;
  dietaryNotes?: string | null;
  notes?: string | null;
}

@Injectable()
export class SisService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  // --- profile ---------------------------------------------------------------
  async getProfile(p: Principal, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const profile = await tx.studentProfile.findFirst({ where: { studentId } });
      if (!profile) throw new NotFoundException("Student profile not found");
      return profile;
    });
  }

  /** Create or update a student's profile (write roles only). */
  async upsertProfile(p: Principal, studentId: string, input: ProfileInput) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const data = {
        admissionNumber: input.admissionNumber ?? null,
        dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
        gender: input.gender ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        country: input.country ?? null,
        postalCode: input.postalCode ?? null,
        notes: input.notes ?? null,
      };
      const profile = await tx.studentProfile.upsert({
        where: { studentId },
        update: data,
        create: { schoolId: p.schoolId, studentId, ...data },
      });
      await this.log(tx, p, "sis.profile.upsert", "student_profile", profile.id, { studentId });
      return profile;
    });
  }

  // --- emergency contacts ----------------------------------------------------
  async listContacts(p: Principal, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const profile = await this.requireProfile(tx, studentId);
      return tx.emergencyContact.findMany({
        where: { profileId: profile.id },
        orderBy: { priority: "asc" },
      });
    });
  }

  async addContact(p: Principal, studentId: string, input: ContactInput) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const profile = await this.requireProfile(tx, studentId);
      const contact = await tx.emergencyContact.create({
        data: {
          schoolId: p.schoolId,
          profileId: profile.id,
          name: input.name,
          relationship: input.relationship,
          phone: input.phone,
          email: input.email ?? null,
          priority: input.priority ?? 1,
        },
      });
      await this.log(tx, p, "sis.contact.add", "emergency_contact", contact.id, { studentId });
      return contact;
    });
  }

  async updateContact(p: Principal, studentId: string, contactId: string, input: Partial<ContactInput>) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const profile = await this.requireProfile(tx, studentId);
      // SECURITY: scope the contact to THIS student's profile (and, via RLS, this
      // tenant) — 404 if it isn't, never reveal another student's contact.
      const existing = await tx.emergencyContact.findFirst({
        where: { id: contactId, profileId: profile.id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException("Contact not found");
      const contact = await tx.emergencyContact.update({
        where: { id: contactId },
        data: {
          name: input.name,
          relationship: input.relationship,
          phone: input.phone,
          email: input.email ?? undefined,
          priority: input.priority,
        },
      });
      await this.log(tx, p, "sis.contact.update", "emergency_contact", contactId, { studentId });
      return contact;
    });
  }

  async removeContact(p: Principal, studentId: string, contactId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const profile = await this.requireProfile(tx, studentId);
      const existing = await tx.emergencyContact.findFirst({
        where: { id: contactId, profileId: profile.id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException("Contact not found");
      await tx.emergencyContact.delete({ where: { id: contactId } });
      await this.log(tx, p, "sis.contact.remove", "emergency_contact", contactId, { studentId });
      return { id: contactId, removed: true };
    });
  }

  // --- medical (sensitive: read AND write are audited) -----------------------
  async getMedical(p: Principal, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const profile = await this.requireProfile(tx, studentId);
      const record = await tx.medicalRecord.findFirst({ where: { profileId: profile.id } });
      // Golden Rule #5: log the READ of a minor's medical record, with the actor.
      await this.log(tx, p, "sis.medical.read", "medical_record", record?.id ?? profile.id, {
        studentId,
        present: Boolean(record),
      });
      // Sensitive fields are stored encrypted; decrypt for the authorized reader.
      return record ? this.decryptMedical(record, p.schoolId) : null;
    });
  }

  private readonly MEDICAL_FIELDS = [
    "bloodGroup",
    "allergies",
    "conditions",
    "medications",
    "dietaryNotes",
    "notes",
  ] as const;

  private decryptMedical(record: Record<string, unknown>, schoolId: string) {
    const out = { ...record };
    for (const f of this.MEDICAL_FIELDS) {
      if (typeof out[f] === "string") out[f] = decryptField(out[f] as string, schoolId);
    }
    return out;
  }

  async upsertMedical(p: Principal, studentId: string, input: MedicalInput) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const profile = await this.requireProfile(tx, studentId);
      // Encrypt sensitive fields at rest (per-tenant key). Reads decrypt them.
      const sid = p.schoolId;
      const data = {
        bloodGroup: encryptField(input.bloodGroup ?? null, sid),
        allergies: encryptField(input.allergies ?? null, sid),
        conditions: encryptField(input.conditions ?? null, sid),
        medications: encryptField(input.medications ?? null, sid),
        dietaryNotes: encryptField(input.dietaryNotes ?? null, sid),
        notes: encryptField(input.notes ?? null, sid),
      };
      const record = await tx.medicalRecord.upsert({
        where: { profileId: profile.id },
        update: data,
        create: { schoolId: p.schoolId, profileId: profile.id, ...data },
      });
      await this.log(tx, p, "sis.medical.upsert", "medical_record", record.id, { studentId });
      return this.decryptMedical(record, p.schoolId);
    });
  }

  // --- relationship scoping --------------------------------------------------
  /** Throws 404 unless the caller is allowed to see this student's SIS data. */
  private async assertCanAccessStudent(tx: TenantTx, p: Principal, studentId: string) {
    if (this.isSchoolWide(p)) return;
    if (p.userId === studentId) return; // student viewing own record

    // Parent of this student?
    const link = await tx.parentChild.findFirst({
      where: { parentId: p.userId, studentId },
      select: { id: true },
    });
    if (link) return;

    // Teacher of a class this student is enrolled in?
    const taught = await tx.classTeacher.findMany({
      where: { teacherId: p.userId },
      select: { classId: true },
    });
    if (taught.length > 0) {
      const enrolled = await tx.enrollment.findFirst({
        where: {
          studentId,
          classId: { in: taught.map((t: { classId: string }) => t.classId) },
        },
        select: { id: true },
      });
      if (enrolled) return;
    }

    // SECURITY: 404 (not 403) — never reveal a student the caller can't see.
    throw new NotFoundException("Student not found");
  }

  private async requireProfile(tx: TenantTx, studentId: string) {
    const profile = await tx.studentProfile.findFirst({
      where: { studentId },
      select: { id: true },
    });
    if (!profile) throw new NotFoundException("Student profile not found");
    return profile;
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entity: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ) {
    await this.audit.record(
      { actorId: p.userId, action, entity, entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
