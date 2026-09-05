// =============================================================================
// The attestation a report card carries INSTEAD of a signature
// =============================================================================
// This platform captures no signature — no image, no certificate, nothing in
// SchoolBranding but a logo and three brand-colour numbers. A printed card has a
// ruled line signed by hand, and the VAULT copy a guardian downloads carried
// that line permanently blank: the digital card was the one nobody had signed.
//
// A STORED SIGNATURE IMAGE WOULD NOT FIX THAT. It is a forgeable credential — a
// signature stamp left in an unlocked drawer — and anyone who can read it can
// put it on any document. What the school has already done is stronger and is
// already audited: a NAMED person wrote the head's remark, and every mark on the
// page passed a two-person GRADE_PUBLISH chain recorded in the immutable
// WorkflowAuditLog. This turns that into something the person holding the card
// can check.
//
// WHAT IS SNAPSHOTTED AND WHY. The approver's name and role are copied, not
// joined: an attestation must still read correctly after they leave or their
// roles change, and a signature that rewrites itself is not a signature. The
// marks are copied so verification can catch a doctored card.
//
// ONE ROW PER PUPIL PER TERM, so the code is stable across regenerations. When
// the content changes the row is REISSUED — version incremented — rather than
// duplicated, so somebody holding an older printout is told theirs has been
// superseded instead of quietly believing a stale page.
// =============================================================================
import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { AttestedSubject, ReportCardAttestationDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { Prisma } from "@sms/db";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";

/** The all-zero uuid used as a principal where there is no acting user — the
 *  same one the other public read paths use to resolve a school by slug. */
const ZERO = "00000000-0000-0000-0000-000000000000";

/** Crockford-style base32 without I, L, O or U, so a code read off a printed
 *  page and typed by hand cannot be confused with 1, 0 or a rude word. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 12 characters ~= 60 bits. Unguessable at any rate a public endpoint allows,
 *  and short enough to type off a page in three groups of four. */
export function generateAttestationCode(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Grouped for a human reading it aloud or typing it; the stored code is bare. */
export function formatAttestationCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

export function normaliseAttestationCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** Everything the attestation covers, in a fixed order, so the same card always
 *  hashes the same and a changed mark always changes the hash. Subjects are
 *  sorted because the order they arrive in is not part of the document. */
export function attestationContentHash(input: {
  approvedById: string;
  termAverage: number | null;
  termGrade: string | null;
  subjects: AttestedSubject[];
}): string {
  const canonical = JSON.stringify({
    a: input.approvedById,
    v: input.termAverage,
    g: input.termGrade,
    s: [...input.subjects]
      .sort((x, y) => x.subject.localeCompare(y.subject))
      .map((x) => [x.subject, x.total, x.grade]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface IssuedAttestation {
  code: string;
  version: number;
  approvedByName: string;
  approvedByRole: string;
  approvedAt: Date;
}

@Injectable()
export class ReportCardAttestationService {
  private readonly logger = new Logger("ReportCardAttestation");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  /**
   * Issue or refresh the attestation for one pupil's term card, INSIDE the
   * caller's transaction so it cannot half-happen.
   *
   * Returns null when there is nothing to attest — no head remark means nobody
   * has signed, and a card that nobody signed must not carry a block saying
   * somebody did. That is the same posture as the blank signature rule it
   * replaces, and it is why this is not simply "always stamp the principal".
   */
  async issueInTx(
    tx: TenantTx,
    input: {
      schoolId: string;
      studentId: string;
      termId: string;
      termAverage: number | null;
      termGrade: string | null;
      subjects: AttestedSubject[];
    },
  ): Promise<IssuedAttestation | null> {
    const remark = await tx.reportCardRemark.findFirst({
      where: { studentId: input.studentId, termId: input.termId },
      select: { headRemark: true, headId: true, headRemarkAt: true, updatedAt: true },
    });
    if (!remark?.headRemark || !remark.headId) return null;

    const author = await tx.user.findFirst({
      where: { id: remark.headId },
      select: { name: true, roles: { select: { role: { select: { name: true } } } } },
    });
    if (!author) return null;

    // The role is the one they held WHEN THEY SIGNED, as far as this can know it
    // — resolved now and then frozen, never re-resolved on a later read.
    const roles = author.roles.map((r) => r.role.name);
    const approvedByRole = roles.includes("principal")
      ? "Principal"
      : roles.includes("head_teacher")
        ? "Head teacher"
        : roles.includes("school_admin")
          ? "School administrator"
          : "Head of school";

    const contentHash = attestationContentHash({
      approvedById: remark.headId,
      termAverage: input.termAverage,
      termGrade: input.termGrade,
      subjects: input.subjects,
    });

    const existing = await tx.reportCardAttestation.findFirst({
      where: { studentId: input.studentId, termId: input.termId },
      select: { id: true, code: true, version: true, contentHash: true, approvedByName: true, approvedByRole: true, approvedAt: true },
    });

    // Nothing about the document has moved, so this is the SAME document being
    // printed again — not a new issue. Bumping the version here would tell every
    // holder their card was superseded every time somebody hit print.
    if (existing && existing.contentHash === contentHash) {
      return {
        code: existing.code,
        version: existing.version,
        approvedByName: existing.approvedByName,
        approvedByRole: existing.approvedByRole,
        approvedAt: existing.approvedAt,
      };
    }

    const approvedAt = remark.headRemarkAt ?? remark.updatedAt;
    const subjects = input.subjects as unknown as Prisma.InputJsonValue;

    if (existing) {
      await tx.reportCardAttestation.update({
        where: { id: existing.id },
        data: {
          approvedById: remark.headId,
          approvedByName: author.name,
          approvedByRole,
          approvedAt,
          termAverage: input.termAverage,
          termGrade: input.termGrade,
          subjects,
          contentHash,
          version: existing.version + 1,
          issuedAt: new Date(),
        },
      });
      return { code: existing.code, version: existing.version + 1, approvedByName: author.name, approvedByRole, approvedAt };
    }

    const code = generateAttestationCode();
    await tx.reportCardAttestation.create({
      data: {
        schoolId: input.schoolId,
        studentId: input.studentId,
        termId: input.termId,
        code,
        approvedById: remark.headId,
        approvedByName: author.name,
        approvedByRole,
        approvedAt,
        termAverage: input.termAverage,
        termGrade: input.termGrade,
        subjects,
        contentHash,
      },
    });
    return { code, version: 1, approvedByName: author.name, approvedByRole, approvedAt };
  }

  /**
   * PUBLIC: resolve a code printed on a card.
   *
   * NO CROSS-TENANT READ, which is the whole reason the URL carries the school's
   * slug. The school is resolved from the RLS-exempt registry FIRST, then the
   * lookup runs under that school's GUC — so an unauthenticated verifier is
   * confined by exactly the policy a member of staff is, and a code belonging to
   * another school does not exist to the query. The alternative, a privileged
   * client on an internet-facing route, would have given a public endpoint more
   * reach than the app role has (Golden Rule #4).
   *
   * 404 for everything: unknown school, unknown code, wrong school for the code.
   * A verifier who mistypes must not learn which half they got right.
   */
  async verify(slug: string, rawCode: string): Promise<ReportCardAttestationDto> {
    const code = normaliseAttestationCode(rawCode);
    if (code.length !== 12) throw new NotFoundException("No card matches that code");

    // A DISABLED SCHOOL'S CARDS STILL VERIFY, deliberately, and this is the one
    // place that differs from the other public routes. Those refuse a switched-
    // off school because it cannot act on what arrives. Verification asks the
    // school for nothing — it reports a thing that was true when it happened —
    // and withholding it would penalise the pupil for the school's billing.
    const school = await this.db.runAsTenant<{ id: string; name: string } | null>(
      { schoolId: ZERO, userId: ZERO },
      (tx) => tx.school.findFirst({ where: { slug, isPlatform: false }, select: { id: true, name: true } }),
    );
    if (!school) throw new NotFoundException("No card matches that code");

    const found = await this.db.runAsTenant({ schoolId: school.id, userId: ZERO }, async (tx) => {
      const row = await tx.reportCardAttestation.findFirst({
        where: { code },
        select: {
          studentId: true, termId: true, approvedByName: true, approvedByRole: true,
          approvedAt: true, termAverage: true, termGrade: true, subjects: true,
          version: true, issuedAt: true,
        },
      });
      if (!row) return null;
      const [student, term] = await Promise.all([
        tx.user.findFirst({ where: { id: row.studentId }, select: { name: true } }),
        tx.term.findFirst({
          where: { id: row.termId },
          select: { name: true, session: { select: { name: true } } },
        }),
      ]);
      const enrolment = await tx.enrollment.findFirst({
        where: { studentId: row.studentId },
        orderBy: { enrolledAt: "desc" },
        select: { class: { select: { name: true } } },
      });
      return { row, studentName: student?.name ?? null, term, className: enrolment?.class?.name ?? null };
    });
    if (!found || !found.studentName || !found.term) throw new NotFoundException("No card matches that code");

    // AUDITED, because this returns a minor's academic record (Golden Rule #5).
    // The actor is the system: the caller is unauthenticated by design, and
    // inventing an identity for them would make the trail say something untrue.
    // What the row records is that this code was resolved and when — which is
    // what an investigation into a leaked code actually needs.
    await this.audit
      .record({
        actorId: SYSTEM_ACTOR_ID,
        action: "reportcard.attestation.verify",
        entity: "user",
        entityId: found.row.studentId,
        schoolId: school.id,
        metadata: { termId: found.row.termId, version: found.row.version },
      })
      .catch((e: unknown) => this.logger.warn(`attestation verify not audited: ${String(e)}`));

    return {
      schoolName: school.name,
      studentName: found.studentName,
      className: found.className,
      termName: found.term.name,
      sessionName: found.term.session?.name ?? null,
      approvedByName: found.row.approvedByName,
      approvedByRole: found.row.approvedByRole,
      approvedAt: found.row.approvedAt,
      termAverage: found.row.termAverage,
      termGrade: found.row.termGrade,
      subjects: found.row.subjects as unknown as AttestedSubject[],
      version: found.row.version,
      issuedAt: found.row.issuedAt,
    };
  }
}
