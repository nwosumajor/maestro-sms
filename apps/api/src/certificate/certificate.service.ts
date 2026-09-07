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

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { assertDocumentsReleasable } from "../lms/leaver-documents";
import { randomUUID } from "node:crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
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

  /** Issue an ID card or certificate -> returns the PDF bytes + a filename. */
  async issue(
    p: Principal,
    input: { type: string; subjectId: string; title?: string; body?: string },
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
      const reprint =
        input.title === undefined && input.body === undefined
          ? await tx.issuedCertificate.findFirst({
              where: { subjectId: input.subjectId, type: input.type },
              select: { serial: true },
              orderBy: { createdAt: "asc" },
            })
          : null;
      const serial = reprint?.serial ?? certificateSerial(input.type);
      if (!reprint) {
        await tx.issuedCertificate.create({
          data: {
            schoolId: p.schoolId,
            type: input.type,
            subjectId: input.subjectId,
            title: input.title ?? null,
            body: input.body ?? null,
            issuedById: p.userId,
            serial,
          },
        });
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
      };
    });

    // The school's uploaded logo (embedded into the document); null if unset.
    const logo = await this.branding.getLogoBytes(p.schoolId).catch(() => null);
    const issuedOn = new Date();
    const buffer =
      input.type === "ID_CARD"
        ? await renderIdCard({ ...data, issuedOn }, logo)
        : await renderCertificate({ ...data, type: input.type, title: input.title, body: input.body, issuedOn }, logo);
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

  async history(p: Principal, subjectId: string) {
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.issuedCertificate.findMany({ where: { subjectId }, orderBy: { createdAt: "desc" }, take: 100 }),
    );
  }

}
