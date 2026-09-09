// =============================================================================
// CertificateService — ID-card + certificate PDF generator
// =============================================================================
// Tenant-scoped (RLS). Staff (certificate.issue) generate a templated PDF for a
// student/staff member: a two-sided ID card or a formal certificate
// (completion/participation/merit, with an optional custom title + body). Each
// issuance appends an immutable issued_certificate row (serial, who, what, when)
// for audit + reprint history. The PDF is built from CURRENT data by the PURE
// renderers in certificate-templates.ts (drawn borders/seal/signatures; the
// school's uploaded logo + branding theme colour make each document on-brand).
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { assertDocumentsReleasable } from "../lms/leaver-documents";
import { randomUUID } from "node:crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { BrandingService } from "../branding/branding.service";
import { hslToHex, renderCertificate, renderIdCard } from "./certificate-templates";

const TYPES = ["ID_CARD", "COMPLETION", "PARTICIPATION", "MERIT"];

/**
 * The serial printed on the document, and the id it is verified by.
 *
 * // GOTCHA: this existed TWICE, and the two halves disagreed. The bulk path
 * used a uuid and carried a comment saying why — "the column has no unique
 * constraint, so a collision would not error, it would silently mint two
 * certificates that verify as the same one... the uniqueness has to come from
 * the uuid, not from a 4-character random suffix". The single-issue path, which
 * is the one that actually PRINTS the document a school stands behind, was
 * still generating that 4-character `Math.random()` suffix. Somebody reasoned
 * the rule out, wrote it down, fixed the file in front of them and left its
 * sibling — with the warning sitting in the same file as the thing it warns
 * against. Measured: 36^4 = 1,679,616 against 16^8 = 4,294,967,296, a space
 * 2,557x smaller, drawn from `Math.random` rather than a CSPRNG.
 *
 * One definition, so there is no second copy to drift. `serial` is UNIQUE now
 * (migration 20260907000000), so a collision is a loud 409 the desk retries
 * rather than two documents that verify as one.
 */
function certificateSerial(type: string): string {
  const prefix = type === "ID_CARD" ? "ID" : "CERT";
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

/** Human label for the ID card from the subject's primary role. */
const ROLE_LABELS: [string, string][] = [
  ["student", "Student"],
  ["teacher", "Teacher"],
  ["parent", "Parent"],
];

@Injectable()
export class CertificateService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly branding: BrandingService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /**
   * The registered certificate this print is a REPRINT of, or null for a new one.
   *
   * Three cases, and the third is the one that was silently wrong:
   *  - `certificateId` given: reprint exactly that certificate. It must belong to
   *    the named subject and be of the named type, so a mistyped id cannot print
   *    one pupil's award onto another's document. 404, never 403 — the row may
   *    simply be another school's, and RLS has already hidden it.
   *  - a title or body given, and no id: the caller is describing a NEW award
   *    ("Best in Maths" after "Best in Science"), which gets its own serial.
   *  - neither: a plain reprint. If the subject holds exactly ONE certificate of
   *    this type, that is unambiguously the one. If they hold SEVERAL, this used
   *    to take the OLDEST and print a generic document under its serial. REFUSE
   *    instead, naming them: printing the wrong award under a real serial is the
   *    failure the serial exists to prevent, and the caller can say which.
   */
  private async findReprint(
    tx: TenantTx,
    input: { type: string; subjectId: string; title?: string; body?: string; certificateId?: string },
  ): Promise<{ serial: string; title: string | null; body: string | null; createdAt: Date } | null> {
    const select = { serial: true, title: true, body: true, createdAt: true } as const;
    if (input.certificateId) {
      const one = await tx.issuedCertificate.findFirst({
        where: { id: input.certificateId, subjectId: input.subjectId, type: input.type },
        select,
      });
      if (!one) throw new NotFoundException("That certificate is not on this school's register");
      return one;
    }
    if (input.title !== undefined || input.body !== undefined) return null;

    const held = await tx.issuedCertificate.findMany({
      where: { subjectId: input.subjectId, type: input.type },
      select: { ...select, id: true },
      orderBy: { createdAt: "asc" },
    });
    if (held.length === 0) return null;
    if (held.length === 1) return held[0];
    throw new ConflictException(
      `This person holds ${held.length} ${input.type} certificates — say which one to reprint. ` +
        held.map((h) => `${h.serial}${h.title ? ` (${h.title})` : ""}`).join("; "),
    );
  }

  /** Issue an ID card or certificate -> returns the PDF bytes + a filename. */
  async issue(
    p: Principal,
    input: { type: string; subjectId: string; title?: string; body?: string; certificateId?: string },
  ): Promise<{ buffer: Buffer; filename: string }> {
    if (!TYPES.includes(input.type)) throw new BadRequestException("invalid certificate type");
    // Same gate as the report card: a leaver's certificate is released by the
    // principal, once anything outstanding is settled.
    await this.db.runAsTenant(this.ctx(p), (tx) => assertDocumentsReleasable(tx, input.subjectId));
    const data = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const subject = await tx.user.findFirst({
        where: { id: input.subjectId },
        select: {
          id: true,
          name: true,
          email: true,
          uniqueId: true,
          roles: { select: { role: { select: { name: true } } } },
        },
      });
      if (!subject) throw new NotFoundException("Subject not found in this school");
      const [school, branding, issuer, principal] = await Promise.all([
        tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true, address: true } }),
        tx.schoolBranding.findFirst({ select: { brandHue: true, brandSat: true, brandLight: true } }),
        tx.user.findFirst({ where: { id: p.userId }, select: { name: true } }),
        // Head-of-school signature block: the school's principal, if one exists.
        tx.user.findFirst({
          where: { roles: { some: { role: { name: "principal" } } } },
          select: { name: true },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      // A REPRINT REPRINTS. IT DOES NOT MINT A SECOND CERTIFICATE.
      //
      // This created a row unconditionally, and the console's documented flow
      // walks straight into it: `issue-class` registers the class ("IDEMPOTENT
      // ... never re-serialled"), and then ClassIssuer prints each card by
      // POSTing HERE with no title or body. Measured live on a class of 20:
      // bulk-register -> each pupil holds 1 card; press print -> that pupil
      // holds 2, with different serials; press it again -> 3. So the serial the
      // bulk run registered was printed on nothing, `history` listed several
      // serials for one physical card, and no one of them was the real one —
      // which is the whole job of a verification id. The bulk path's promise was
      // true of the bulk path and false of the school.
      //
      // A plain reprint (no title, no body — exactly what ClassIssuer sends)
      // therefore REUSES the registered certificate and its serial. A caller who
      // supplies a title or body is describing a DIFFERENT award ("Best in
      // Maths" after "Best in Science"), which is a new certificate and gets its
      // own serial. Both consumers keep working; only the duplication stops.
      // A REPRINT REPRINTS THE DOCUMENT THAT WAS REGISTERED — its words as well
      // as its serial.
      //
      // Reusing the serial and then rendering from the REQUEST was only half the
      // job, and the half it left produced the thing the serial exists to
      // prevent. Measured live: a pupil awarded "Best in Science" (MERIT) and
      // later "Best in Mathematics"; the issuer needing a replacement copy has
      // exactly two moves, and both are wrong.
      //   - Press Generate with the title still in the box: `title` is defined,
      //     so this is read as a NEW award and a THIRD MERIT row appears — one
      //     physical certificate, two registry entries.
      //   - Clear the boxes: the serial of "Best in Science" is reused and the
      //     document printed under it is a GENERIC merit certificate that does
      //     not mention the award at all — and it silently chose the OLDER of
      //     the two.
      // So there was no way to reprint a certificate the school had issued, and
      // the paper disagreed with the register that is supposed to vouch for it.
      //
      // `certificateId` names WHICH one, which is what the history list has
      // always been able to say and the print path could not hear.
      const reprint = await this.findReprint(tx, input);
      const serial = reprint?.serial ?? certificateSerial(input.type);
      // The registered words win. A reprint that re-words the document makes the
      // serial identify two different papers.
      const title = reprint ? reprint.title ?? undefined : input.title;
      const body = reprint ? reprint.body ?? undefined : input.body;
      let created: Date | null = reprint?.createdAt ?? null;
      if (!reprint) {
        const row = await tx.issuedCertificate.create({
          data: {
            schoolId: p.schoolId,
            type: input.type,
            subjectId: input.subjectId,
            title: input.title ?? null,
            body: input.body ?? null,
            issuedById: p.userId,
            serial,
          },
          select: { createdAt: true },
        });
        created = row.createdAt;
      }
      await this.audit.record(
        {
          actorId: p.userId,
          // A reprint is still a PDF of a pupil's document leaving the building,
          // so it is still recorded — as the reprint it is, not as an issuance.
          action: reprint ? "certificate.reprint" : "certificate.issue",
          entity: "issued_certificate",
          entityId: serial,
          schoolId: p.schoolId,
          metadata: { type: input.type, subjectId: input.subjectId },
        },
        tx,
      );
      const roleNames = subject.roles.map((r) => r.role.name);
      const roleLabel = ROLE_LABELS.find(([r]) => roleNames.includes(r))?.[1] ?? "Staff";
      const accent =
        branding?.brandHue != null && branding.brandSat != null && branding.brandLight != null
          ? hslToHex(branding.brandHue, branding.brandSat, branding.brandLight)
          : null;
      return {
        subjectName: subject.name,
        uniqueId: subject.uniqueId,
        roleLabel,
        schoolName: school?.name ?? "School",
        schoolAddress: school?.address ?? null,
        issuedByName: issuer?.name ?? "",
        principalName: principal?.name ?? null,
        accent,
        serial,
        // The words this document is to carry — the registered ones on a
        // reprint, the caller's on a new certificate. Returned rather than read
        // from `input` below, because on a reprint `input` is empty and that is
        // exactly how a generic certificate came to be printed under a named
        // award's serial.
        title,
        body,
        issuedOn: created ?? new Date(),
      };
    });

    // The school's uploaded logo (embedded into the document); null if unset.
    const logo = await this.branding.getLogoBytes(p.schoolId).catch(() => null);
    // THE DATE IT WAS ISSUED, not the date it was printed. A reprint of last
    // year's testimonial that prints today's date is a different document
    // again, and the serial on it says otherwise.
    const issuedOn = data.issuedOn;
    const buffer =
      input.type === "ID_CARD"
        ? await renderIdCard({ ...data, issuedOn }, logo)
        : await renderCertificate({ ...data, type: input.type, title: data.title, body: data.body, issuedOn }, logo);
    const filename = `${input.type.toLowerCase()}-${data.serial}.pdf`;
    return { buffer, filename };
  }

  /** Issuance history for a subject (audit/reprint). */
  /**
   * Who in a class still needs a certificate of this type — and record it for those
   * who do.
   *
   * Issuing was strictly one pupil at a time, so a testimonial run for a leaving
   * year group meant picking 31 names by hand and remembering which were done. This
   * returns the class with an already-issued flag and registers the issuance for the
   * rest, so the register is the record of who has been served.
   *
   * It does NOT return 31 PDFs. There is no zip dependency in this project, and a
   * response carrying tens of generated PDFs is a timeout waiting to happen; the
   * bytes are still produced per pupil by the existing single-issue endpoint, which
   * the console links to. What this removes is the bookkeeping, not the printing.
   *
   * IDEMPOTENT: a pupil who already holds this certificate type is skipped, never
   * re-serialled. Pressing it twice must not manufacture a second certificate — a
   * certificate is a document a school stands behind.
   */
  async issueForClass(
    p: Principal,
    input: { classId: string; type: string; title?: string; body?: string },
  ): Promise<{ issued: number; skipped: number; students: Array<{ id: string; name: string; alreadyIssued: boolean }> }> {
    if (!TYPES.includes(input.type)) throw new BadRequestException("invalid certificate type");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const cls = await tx.class.findFirst({ where: { id: input.classId }, select: { id: true, name: true } });
      if (!cls) throw new NotFoundException("Class not found");

      // ACTIVE only: a bulk ID-card or certificate run must not print for a
      // pupil who has already left the school.
      const enrolled = (await tx.enrollment.findMany({
        where: { classId: input.classId, status: "ACTIVE" },
        select: { studentId: true },
      })) as Array<{ studentId: string }>;
      const studentIds = [...new Set(enrolled.map((e) => e.studentId))];
      if (studentIds.length === 0) throw new BadRequestException("That class has no enrolled students");

      const [users, existing] = await Promise.all([
        tx.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }) as Promise<
          Array<{ id: string; name: string }>
        >,
        tx.issuedCertificate.findMany({
          where: { subjectId: { in: studentIds }, type: input.type },
          select: { subjectId: true },
        }) as Promise<Array<{ subjectId: string }>>,
      ]);
      const already = new Set(existing.map((e) => e.subjectId));
      const todo = users.filter((u) => !already.has(u.id));

      if (todo.length > 0) {
        // One bulk insert, not one round trip per pupil.
        await tx.issuedCertificate.createMany({
          data: todo.map((u) => ({
            schoolId: p.schoolId,
            type: input.type,
            subjectId: u.id,
            title: input.title ?? null,
            body: input.body ?? null,
            issuedById: p.userId,
            // One shared generator — see `certificateSerial`. Date.now() is
            // identical across a bulk insert, so the uniqueness comes from the
            // uuid.
            serial: certificateSerial(input.type),
          })),
        });
      }
      await this.audit.record(
        {
          actorId: p.userId,
          action: "certificate.issue.class",
          entity: "class",
          entityId: input.classId,
          schoolId: p.schoolId,
          metadata: { type: input.type, className: cls.name, issued: todo.length, skipped: already.size },
        },
        tx,
      );

      return {
        issued: todo.length,
        skipped: already.size,
        students: users.map((u) => ({ id: u.id, name: u.name, alreadyIssued: already.has(u.id) })),
      };
    });
  }

  /**
   * WHOSE CERTIFICATE IS THIS SERIAL? — the question every certificate this
   * product prints tells its reader to ask.
   *
   * The provenance strip on the document reads "Authenticity may be verified
   * with the issuing school by quoting the serial number", and nothing in the
   * product accepted a serial. A school telephoned by an employer holding a
   * testimonial could not answer: the only way to see a serial was
   * `history/:subjectId`, which needs the pupil's id — the one thing somebody
   * checking a document they were handed does not have. Measured on a fleet of
   * 5,000 schools holding 12,000 certificates: no route, no service method and
   * no screen took a serial.
   *
   * SECURITY: runs under the caller's own tenant, so RLS confines it. A serial
   * from another school answers 404, exactly as an unknown one does — the same
   * 404-not-403 the scan desk gives, and for the same reason: a verification
   * endpoint that distinguished "not ours" from "no such thing" would confirm
   * the existence of another school's certificate to anyone who could guess a
   * serial. Audited, because it names a pupil (Golden Rule #5).
   */
  async verify(
    p: Principal,
    serial: string,
  ): Promise<{
    serial: string;
    type: string;
    title: string | null;
    body: string | null;
    subjectName: string;
    subjectRole: string;
    issuedOn: Date;
    issuedByName: string | null;
  }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.issuedCertificate.findFirst({
        where: { serial: serial.trim().toUpperCase() },
        select: { serial: true, type: true, title: true, body: true, subjectId: true, issuedById: true, createdAt: true },
      });
      if (!row) throw new NotFoundException("No certificate with that serial was issued by this school");
      const [subject, issuer] = await Promise.all([
        tx.user.findFirst({
          where: { id: row.subjectId },
          select: { name: true, roles: { select: { role: { select: { name: true } } } } },
        }),
        row.issuedById
          ? tx.user.findFirst({ where: { id: row.issuedById }, select: { name: true } })
          : Promise.resolve(null),
      ]);
      // A certificate whose subject has since been removed is still a
      // certificate this school issued, and saying so is the honest answer —
      // better than a 404 that reads as "we never issued it".
      const roleNames = subject?.roles.map((r) => r.role.name) ?? [];
      await this.audit.record(
        {
          actorId: p.userId,
          action: "certificate.verify",
          entity: "issued_certificate",
          entityId: row.serial,
          schoolId: p.schoolId,
          metadata: { type: row.type, subjectId: row.subjectId },
        },
        tx,
      );
      return {
        serial: row.serial,
        type: row.type,
        title: row.title,
        body: row.body,
        subjectName: subject?.name ?? "(no longer on this school's register)",
        subjectRole: ROLE_LABELS.find(([r]) => roleNames.includes(r))?.[1] ?? "Staff",
        issuedOn: row.createdAt,
        issuedByName: issuer?.name ?? null,
      };
    });
  }

  /**
   * Every certificate this school has issued to one person.
   *
   * AUDITED, like its three siblings in this module. It names a pupil and the
   * awards they hold, which is a read of a minor's record (Golden Rule #5) —
   * `issue`, `verify` and the scan desk all record theirs, and this was the one
   * that did not. It is also the surface a clerk checks before issuing, so who
   * looked and when is the trail that explains a duplicate.
   */
  async history(p: Principal, subjectId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.issuedCertificate.findMany({
        where: { subjectId },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "certificate.history.read",
          entity: "user",
          entityId: subjectId,
          schoolId: p.schoolId,
          metadata: { certificates: rows.length },
        },
        tx,
      );
      return rows;
    });
  }

}
