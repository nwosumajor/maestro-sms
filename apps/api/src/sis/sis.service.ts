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

import {
  BadRequestException, Inject, Injectable, NotFoundException, ConflictException } from "@nestjs/common";
import { allocateAdmissionNumber, loadUsedAdmissionNumbers, schoolAdmissionYear } from "../foundation/admission-number";
import { Prisma } from "@sms/db";
import type { MedicalRecordDto, StudentGuardianDto } from "@sms/types";
import { missingProfileFields, deliverableEmail } from "@sms/types";
import type { ProfileReviewRowDto, SisCompletionDto } from "@sms/types";
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
import { NotificationService } from "../notifications/notification.service";

// Staff who may reach ANY student in their tenant (row-scope short-circuit).
// junior_admin is the operational records tier (CLAUDE.md) and holds
// student.profile.write / student.contact.write — it belongs here so those
// grants aren't dead (it has no class/parent relationship to fall back on).
// Medical stays protected regardless: junior_admin lacks student.medical.*, so
// the PermissionGuard blocks the medical endpoints before this check runs.
// Matches SearchService.ROSTER_WIDE, which already treats junior_admin as
// whole-school.
const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal", "junior_admin"]);

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
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  /**
   * What is waiting for THIS reviewer.
   *
   * The three chain endpoints each act on one named pupil, which is useless
   * until you know which pupil — so both review stages had no way in. This is
   * the way in, and it decides the stage rather than asking the reader which
   * they are:
   *
   *   SUPERVISOR — submitted, not yet checked, in a class this caller supervises.
   *   ADMIN      — checked by the supervisor, waiting on `rbac.manage`.
   *
   * A school-wide role sees both, because they can act on both. One indexed
   * query over submitted profiles, then names; the roster is never walked.
   */
  async profileReviewQueue(p: Principal): Promise<ProfileReviewRowDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const wide = this.isSchoolWide(p);
      const canApprove = wide || p.permissions.includes("rbac.manage");

      // WHO THIS CALLER MAY REVIEW IS PART OF THE QUERY, not a filter applied
      // afterwards. It used to read the 500 oldest SUBMITTED profiles in the
      // school and then keep the ones belonging to classes this person
      // supervises — so the cap was spent on other people's pupils. A
      // supervisor whose class submitted after the first 500 saw an EMPTY
      // queue while their reviews sat waiting, and nothing said why. At the
      // start of a term a large school submits far more than 500 at once.
      const supervised = wide
        ? null
        : (
            (await tx.enrollment.findMany({
              where: { status: "ACTIVE", class: { supervisorId: p.userId } },
              select: { studentId: true },
            })) as Array<{ studentId: string }>
          ).map((e) => e.studentId);

      // The same two-stage rule the Node filter expressed, and the same one
      // `supervisorReview` enforces — so the queue still cannot offer a row the
      // action would refuse. A row past supervisor review belongs to whoever
      // may approve; a row before it belongs to that class's supervisor.
      const mine = { supervisorReviewedAt: null, studentId: { in: supervised ?? [] } };
      const where = wide
        ? { profileStatus: "SUBMITTED" }
        : canApprove
          ? { profileStatus: "SUBMITTED", OR: [{ supervisorReviewedAt: { not: null } }, mine] }
          : { profileStatus: "SUBMITTED", ...mine };

      const visible = (await tx.studentProfile.findMany({
        where,
        select: { studentId: true, submittedAt: true, supervisorReviewedAt: true },
        orderBy: { submittedAt: "asc" },
        take: 500,
      })) as Array<{ studentId: string; submittedAt: Date | null; supervisorReviewedAt: Date | null }>;
      if (visible.length === 0) return [];

      const ids = visible.map((r) => r.studentId);
      const [users, enrolments] = await Promise.all([
        tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
        tx.enrollment.findMany({
          where: { studentId: { in: ids }, status: "ACTIVE" },
          select: { studentId: true, class: { select: { name: true } } },
        }),
      ]);
      const nameOf = new Map((users as Array<{ id: string; name: string }>).map((u) => [u.id, u.name]));
      const classOf = new Map(
        (enrolments as Array<{ studentId: string; class: { name: string } | null }>).map((e) => [e.studentId, e.class?.name ?? null]),
      );
      return visible.map((r) => ({
        studentId: r.studentId,
        studentName: nameOf.get(r.studentId) ?? "Pupil",
        className: classOf.get(r.studentId) ?? null,
        stage: (r.supervisorReviewedAt ? "ADMIN" : "SUPERVISOR") as "ADMIN" | "SUPERVISOR",
        submittedAt: r.submittedAt,
        supervisorReviewedAt: r.supervisorReviewedAt,
      }));
    });
  }

  // --- profile completion + two-stage review ---------------------------------

  /**
   * What the pupil (or their parent) still has to fill in. Drives the on-screen
   * prompt and the nudge, so both read from ONE definition of "complete"
   * (SIS_REQUIRED_PROFILE_FIELDS in @sms/types) rather than two that can drift.
   */
  async completion(p: Principal, studentId: string): Promise<SisCompletionDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const profile = await tx.studentProfile.findFirst({ where: { studentId } });
      const missing = missingProfileFields(profile as never);
      return {
        status: profile?.profileStatus ?? "INCOMPLETE",
        missing,
        complete: missing.length === 0,
        reviewNote: profile?.reviewNote ?? null,
        submittedAt: profile?.submittedAt ?? null,
        approvedAt: profile?.approvedAt ?? null,
      };
    });
  }

  /**
   * The pupil submits their completed profile for review. Refuses while anything
   * required is blank — the whole point is that staff review a FINISHED record, not
   * a half-filled one they have to chase.
   *
   * Submitting clears any previous reviewer note, so a resubmission after
   * CHANGES_REQUESTED presents cleanly.
   */
  async submitProfile(p: Principal, studentId: string): Promise<SisCompletionDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const profile = await tx.studentProfile.findFirst({ where: { studentId } });
      if (!profile) throw new NotFoundException("Student profile not found");
      if (profile.profileStatus === "APPROVED") throw new ConflictException("This profile is already approved");
      const missing = missingProfileFields(profile as never);
      if (missing.length > 0) {
        throw new BadRequestException(`Still to fill in: ${missing.join(", ")}`);
      }
      const updated = await tx.studentProfile.update({
        where: { id: profile.id },
        data: { profileStatus: "SUBMITTED", submittedAt: new Date(), reviewNote: null },
      });
      await this.log(tx, p, "sis.profile.submit", "student_profile", studentId);
      // Tell the reviewers there is something waiting: the class supervisor first.
      await this.notifyReviewers(tx, p, studentId).catch(() => undefined);
      return {
        status: updated.profileStatus,
        missing: [],
        complete: true,
        reviewNote: null,
        submittedAt: updated.submittedAt,
        approvedAt: updated.approvedAt,
      };
    });
  }

  /**
   * STAGE 1 — the class supervisor checks the submitted profile. They may pass it
   * on (to the school admin) or send it back with a note.
   *
   * Authorisation is the RELATIONSHIP, not a permission: the reviewer must be the
   * supervisor of a class this pupil is enrolled in (school-wide staff may also
   * act, since they own the data anyway). 404-not-403 otherwise.
   */
  async supervisorReview(
    p: Principal,
    studentId: string,
    decision: "PASS" | "CHANGES",
    note?: string | null,
  ): Promise<{ status: string }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const profile = await tx.studentProfile.findFirst({ where: { studentId } });
      if (!profile) throw new NotFoundException("Student profile not found");
      if (!(await this.isSupervisorOf(tx, p, studentId))) throw new NotFoundException("Student profile not found");
      if (profile.profileStatus !== "SUBMITTED") {
        throw new ConflictException("Only a submitted profile can be reviewed");
      }
      if (decision === "CHANGES") {
        const updated = await tx.studentProfile.update({
          where: { id: profile.id },
          // Back to the pupil — and back into the nudge loop until resubmitted.
          data: { profileStatus: "CHANGES_REQUESTED", reviewNote: note?.trim() || "Please review and resubmit." },
        });
        await this.log(tx, p, "sis.profile.supervisor_changes", "student_profile", studentId);
        await this.notifyStudent(tx, p, studentId, "Changes requested on your profile", updated.reviewNote ?? "").catch(
          () => undefined,
        );
        return { status: updated.profileStatus };
      }
      await tx.studentProfile.update({
        where: { id: profile.id },
        data: { supervisorReviewedById: p.userId, supervisorReviewedAt: new Date() },
      });
      await this.log(tx, p, "sis.profile.supervisor_pass", "student_profile", studentId);
      await this.notifyAdmins(tx, p, studentId).catch(() => undefined);
      return { status: "SUBMITTED" };
    });
  }

  /**
   * STAGE 2 — the school admin approves. Requires the supervisor to have passed it
   * first (separation of the two stages: an approval that skipped the check would
   * make the supervisor stage decorative).
   */
  async approveProfile(p: Principal, studentId: string): Promise<{ status: string }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const profile = await tx.studentProfile.findFirst({ where: { studentId } });
      if (!profile) throw new NotFoundException("Student profile not found");
      if (profile.profileStatus !== "SUBMITTED") throw new ConflictException("Only a submitted profile can be approved");
      if (!profile.supervisorReviewedAt) {
        throw new ConflictException("The class supervisor has not checked this profile yet");
      }
      const updated = await tx.studentProfile.update({
        where: { id: profile.id },
        data: { profileStatus: "APPROVED", approvedById: p.userId, approvedAt: new Date(), reviewNote: null },
      });
      await this.log(tx, p, "sis.profile.approve", "student_profile", studentId);
      await this.notifyStudent(tx, p, studentId, "Your profile has been approved", "Your school record is now complete — thank you.").catch(
        () => undefined,
      );
      return { status: updated.profileStatus };
    });
  }

  // --- notifications ---------------------------------------------------------
  // Guardians are copied on everything about a minor's record, and every send is
  // best-effort: a notification hiccup must never fail the review itself.

  private async guardiansOf(tx: TenantTx, studentId: string): Promise<string[]> {
    const links = await tx.parentChild.findMany({ where: { studentId }, select: { parentId: true } });
    return links.map((l: { parentId: string }) => l.parentId);
  }

  private async notifyStudent(tx: TenantTx, p: Principal, studentId: string, title: string, body: string): Promise<void> {
    for (const recipientId of [studentId, ...(await this.guardiansOf(tx, studentId))]) {
      await this.notifications
        .enqueue({ schoolId: p.schoolId, userId: p.userId }, { recipientId, type: "SIS_PROFILE", title, body, channels: ["EMAIL"] })
        .catch(() => undefined);
    }
  }

  /** Stage 1 waiting: tell the pupil's class supervisor. */
  private async notifyReviewers(tx: TenantTx, p: Principal, studentId: string): Promise<void> {
    const e = await tx.enrollment.findFirst({
      where: { studentId, status: "ACTIVE" },
      select: { class: { select: { name: true, supervisorId: true } } },
    });
    const supervisorId = e?.class?.supervisorId;
    if (!supervisorId) return; // no supervisor set — the admin queue still shows it
    const student = await tx.user.findFirst({ where: { id: studentId }, select: { name: true } });
    await this.notifications
      .enqueue(
        { schoolId: p.schoolId, userId: p.userId },
        {
          recipientId: supervisorId,
          type: "SIS_PROFILE",
          title: `Profile to check — ${student?.name ?? "a pupil"}`,
          body: `${student?.name ?? "A pupil"} in ${e?.class?.name ?? "your class"} submitted their profile. Check it, then it goes to the school admin.`,
          channels: ["EMAIL"],
        },
      )
      .catch(() => undefined);
  }

  /** Stage 2 waiting: tell the school admins it has passed the supervisor. */
  private async notifyAdmins(tx: TenantTx, p: Principal, studentId: string): Promise<void> {
    const admins = await tx.user.findMany({
      where: { roles: { some: { role: { name: { in: ["school_admin", "principal"] } } } } },
      select: { id: true },
    });
    const student = await tx.user.findFirst({ where: { id: studentId }, select: { name: true } });
    for (const a of admins) {
      await this.notifications
        .enqueue(
          { schoolId: p.schoolId, userId: p.userId },
          {
            recipientId: a.id,
            type: "SIS_PROFILE",
            title: `Profile ready to approve — ${student?.name ?? "a pupil"}`,
            body: "The class supervisor has checked this profile. It is waiting for your approval.",
            channels: ["EMAIL"],
          },
        )
        .catch(() => undefined);
    }
  }

  /** Is the caller the supervisor of a class this pupil is enrolled in? */
  private async isSupervisorOf(tx: TenantTx, p: Principal, studentId: string): Promise<boolean> {
    if (this.isSchoolWide(p)) return true;
    const e = await tx.enrollment.findFirst({
      where: { studentId, status: "ACTIVE", class: { supervisorId: p.userId } },
      select: { id: true },
    });
    return !!e;
  }

  // --- profile ---------------------------------------------------------------
  /**
   * A pupil's SIS record.
   *
   * // SECURITY: audited, and it was not. This returns a minor's date of birth,
   * gender, telephone number, personal email, home address and admission
   * number — the exact category Golden Rule #5 says every read of is logged —
   * and it is the single most-opened PII read in the product, since it is what
   * the pupil record page loads.
   *
   * The asymmetry is what gave it away: `getMedical` two hundred lines below
   * audits, `listGuardians` immediately after it audits, and the profile
   * between them did not. Verified against the running system before the fix —
   * opening a pupil produced ONE audit row, `sis.medical.read`, and nothing for
   * the profile. So "who looked at this child's record" could be answered for
   * their allergies and not for their home address.
   */
  async getProfile(p: Principal, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const profile = await tx.studentProfile.findFirst({ where: { studentId } });
      if (!profile) throw new NotFoundException("Student profile not found");
      await this.log(tx, p, "sis.profile.read", "student_profile", studentId);
      return profile;
    });
  }

  /**
   * The parent accounts linked to a pupil.
   *
   * `parent_child` drove everything that mattered — who is notified, whose
   * /family page shows this child, which invoices a parent may open — and could
   * not be READ anywhere. So a teacher or a principal looking at a pupil could
   * not see which parent account was attached, nor how to reach it, and "we
   * never received the invoice" had no answer in the product.
   *
   * Scoped exactly like the profile above (staff-wide, a teacher of the pupil's
   * class, the pupil, or a linked guardian), and AUDITED: this is contact data
   * about a family, which Golden Rule #5 puts in the same category as the rest
   * of a minor's record.
   *
   * `reachableByEmail` is the useful half. A provisioned account can carry a
   * GENERATED login identifier rather than a mailbox, and every notice sent to
   * it disappears — the same defect the delivery path guards against. Saying so
   * here is what lets somebody fix it before the next fee run.
   */
  async listGuardians(p: Principal, studentId: string): Promise<StudentGuardianDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const links = (await tx.parentChild.findMany({
        where: { studentId },
        select: { parentId: true },
      })) as Array<{ parentId: string }>;
      if (links.length === 0) {
        // Audited BEFORE the early return, not after it. The log answers "who
        // looked at this child's record", which is a question about the ACCESS,
        // not about what it happened to contain — and the same click was
        // recorded for a pupil with guardians and silently not for a pupil
        // without. Found by opening a pupil who had none.
        await this.log(tx, p, "sis.guardians.read", "user", studentId, { guardians: 0 });
        return [];
      }
      const parents = (await tx.user.findMany({
        where: { id: { in: links.map((l) => l.parentId) } },
        // `loginEmailGenerated` is what deliverableEmail actually keys on.
        // Without it in the select, a generated identifier reads as a perfectly
        // good mailbox and `reachableByEmail` is true for everybody — the
        // opposite of what this field exists to say.
        select: { id: true, name: true, email: true, contactEmail: true, phone: true, loginEmailGenerated: true },
        orderBy: { name: "asc" },
      })) as Array<{
        id: string;
        name: string;
        email: string;
        contactEmail: string | null;
        phone: string | null;
        loginEmailGenerated: boolean | null;
      }>;
      await this.log(tx, p, "sis.guardians.read", "user", studentId, { guardians: parents.length });
      return parents.map((u) => {
        const deliverable = deliverableEmail(u);
        return {
          id: u.id,
          name: u.name,
          email: deliverable,
          phone: u.phone,
          reachableByEmail: deliverable !== null,
        };
      });
    });
  }

  /** Create or update a student's profile (write roles only). */
  async upsertProfile(p: Principal, studentId: string, input: ProfileInput) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const existing = await tx.studentProfile.findFirst({
        where: { studentId },
        select: { admissionNumber: true },
      });
      // The admission number is a STABLE, auto-generated key. Protect it:
      //   * an explicit non-blank value SETS/CORRECTS it (uniqueness enforced),
      //   * a blank field NEVER nulls an existing number (no accidental wipe),
      //   * a legacy/new profile with none GETS one, so every profile has a key.
      let admissionNumber: string | null;
      if (input.admissionNumber?.trim()) {
        admissionNumber = input.admissionNumber.trim();
      } else if (existing?.admissionNumber) {
        admissionNumber = existing.admissionNumber;
      } else {
        // The SCHOOL's year, not the server's — see schoolAdmissionYear.
        const year = await schoolAdmissionYear(tx, p.schoolId);
        const used = await loadUsedAdmissionNumbers(tx, year);
        admissionNumber = allocateAdmissionNumber(used, year);
      }
      const data = {
        admissionNumber,
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
      let profile;
      try {
        profile = await tx.studentProfile.upsert({
          where: { studentId },
          update: data,
          create: { schoolId: p.schoolId, studentId, ...data },
        });
      } catch (e) {
        // The new @@unique([schoolId, admissionNumber]): a typed number already
        // belongs to another pupil. Clean 409, not a 500.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new ConflictException("That admission number is already used by another student in this school.");
        }
        throw e;
      }
      await this.log(tx, p, "sis.profile.upsert", "student_profile", profile.id, { studentId });
      return profile;
    });
  }

  // --- emergency contacts ----------------------------------------------------
  /**
   * A child's emergency contacts: the names, relationships and PHONE NUMBERS of
   * the adults responsible for them.
   *
   * AUDITED, per Golden Rule #5. This read was the only one in the file that was
   * not — the profile, the guardians and the medical record all log, and so does
   * every WRITE to these same rows, so adding a contact was recorded while
   * reading the whole list was not. The live log made it plain: 193
   * sis.guardians.read entries, 19 sis.medical.read, and no contact-read action
   * in existence at all.
   *
   * The COUNT is recorded and never the numbers. An audit trail is read by
   * people investigating access, who have no business being handed the contact
   * details as a side effect of checking who looked at them.
   */
  async listContacts(p: Principal, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const profile = await this.requireProfile(tx, studentId);
      const contacts = await tx.emergencyContact.findMany({
        where: { profileId: profile.id },
        orderBy: { priority: "asc" },
      });
      await this.log(tx, p, "sis.contact.read", "user", studentId, { contacts: contacts.length });
      return contacts;
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
          // Distinguish "absent" (leave as-is) from an explicit null (clear it):
          // `?? undefined` would swallow a null and make the email un-clearable.
          email: input.email === undefined ? undefined : input.email,
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

  private decryptMedical(record: Record<string, unknown>, schoolId: string): MedicalRecordDto {
    const out = { ...record };
    for (const f of this.MEDICAL_FIELDS) {
      if (typeof out[f] === "string") out[f] = decryptField(out[f] as string, schoolId);
    }
    // Decryption is dynamic per-field; the row carries the typed MedicalRecordDto
    // columns plus internal ids, which the DTO narrows to the reader's view.
    return out as unknown as MedicalRecordDto;
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
      // SECURITY: ACTIVE only. Without the status filter this asked "was this
      // pupil EVER in a class I teach", so a teacher kept access to a pupil who
      // had since withdrawn, transferred or been promoted out — indefinitely,
      // and to their records rather than merely their name. Proven live: a
      // pupil was set to WITHDRAWN and their old teacher still fetched a signed
      // download URL for their report card. Whole-school staff are unaffected,
      // so the school can still produce a departed pupil's paperwork.
      const enrolled = await tx.enrollment.findFirst({
        where: {
          studentId,
          status: "ACTIVE",
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
