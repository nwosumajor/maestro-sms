// =============================================================================
// LetterService — official HR letters on the school letterhead (pdfkit)
// =============================================================================
// Generates EMPLOYMENT / CONFIRMATION / PROMOTION / EXPERIENCE letters on demand
// from the live employee record — no letters table; every issuance is audited
// with a deterministic reference number that's printed on the letter, so any
// copy can be traced back to its audit entry. SECURITY: salary never appears on
// a letter (they get handed to banks/embassies/other schools); the school logo
// embed is best-effort (a broken image must never block an official letter).
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import PDFDocument from "pdfkit";
import { BrandingService } from "../branding/branding.service";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

export type LetterType = "EMPLOYMENT" | "CONFIRMATION" | "PROMOTION" | "EXPERIENCE";
const LETTER_TYPES = new Set<string>(["EMPLOYMENT", "CONFIRMATION", "PROMOTION", "EXPERIENCE"]);

const TITLES: Record<LetterType, string> = {
  EMPLOYMENT: "CONFIRMATION OF EMPLOYMENT",
  CONFIRMATION: "CONFIRMATION OF APPOINTMENT",
  PROMOTION: "LETTER OF PROMOTION",
  EXPERIENCE: "SERVICE / EXPERIENCE LETTER",
};

interface LetterFacts {
  name: string;
  jobTitle: string;
  department: string | null;
  gradeLevel: string | null;
  employmentType: string;
  startDate: Date;
  endDate: Date | null;
  status: string;
  confirmationStatus: string;
}

@Injectable()
export class LetterService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly branding: BrandingService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async generate(
    p: Principal,
    userId: string,
    type: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    if (!LETTER_TYPES.has(type)) throw new BadRequestException("unknown letter type");
    const t = type as LetterType;
    const data = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const emp = await tx.employee.findFirst({ where: { userId } });
      if (!emp) throw new NotFoundException("Employee record not found");
      if (t === "CONFIRMATION" && emp.confirmationStatus !== "CONFIRMED") {
        throw new BadRequestException("This employee has not been confirmed yet");
      }
      if (t === "EXPERIENCE" && emp.status === "ACTIVE" && !emp.endDate) {
        // Allowed (current staff ask for experience letters too) — just noted.
      }
      const user = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } });
      // Deterministic, printable reference — resolvable back to the audit trail.
      const ref = `${(school?.name ?? "SMS").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}/HR/${t.slice(0, 3)}/${userId.slice(0, 8).toUpperCase()}`;
      await this.audit.record(
        { actorId: p.userId, action: "hr.letter.issue", entity: "employee", entityId: emp.id, schoolId: p.schoolId, metadata: { userId, type: t, ref } },
        tx,
      );
      return {
        school: school?.name ?? "School",
        ref,
        facts: {
          name: user?.name ?? "Staff member",
          jobTitle: emp.jobTitle,
          department: emp.department,
          gradeLevel: emp.gradeLevel,
          employmentType: emp.employmentType,
          startDate: emp.startDate,
          endDate: emp.endDate,
          status: emp.status,
          confirmationStatus: emp.confirmationStatus,
        } satisfies LetterFacts,
      };
    });
    const logo = await this.branding.getLogoBytes(p.schoolId).catch(() => null);
    const buffer = await this.render(t, data.school, data.ref, data.facts, logo);
    return { buffer, filename: `${t.toLowerCase()}-letter-${userId.slice(0, 8)}.pdf` };
  }

  private body(t: LetterType, f: LetterFacts, school: string): string {
    const since = f.startDate.toISOString().slice(0, 10);
    const dept = f.department ? `, ${f.department} department` : "";
    const grade = f.gradeLevel ? ` (grade ${f.gradeLevel})` : "";
    const typeLabel = f.employmentType.replace(/_/g, "-").toLowerCase();
    switch (t) {
      case "EMPLOYMENT":
        return (
          `This is to certify that ${f.name} is a ${typeLabel} member of staff of ${school}, ` +
          `employed as ${f.jobTitle}${grade}${dept} since ${since}. ` +
          `They remain in our employment as at the date of this letter.\n\n` +
          `This letter is issued at the request of the staff member for whatever lawful purpose it may serve.`
        );
      case "CONFIRMATION":
        return (
          `Following the satisfactory completion of the probationary period, we are pleased to confirm the ` +
          `appointment of ${f.name} as ${f.jobTitle}${grade}${dept} of ${school}, with effect from the date of this letter.\n\n` +
          `All other terms and conditions of service remain as previously communicated. We congratulate them and ` +
          `look forward to their continued contribution.`
        );
      case "PROMOTION":
        return (
          `We are pleased to notify ${f.name} of their promotion to the position of ${f.jobTitle}${grade}${dept} ` +
          `at ${school}, effective from the date of this letter.\n\n` +
          `This promotion reflects the confidence of the school in their dedication and performance. ` +
          `Any revision of remuneration will be communicated separately.`
        );
      case "EXPERIENCE": {
        const until = f.endDate ? f.endDate.toISOString().slice(0, 10) : "date";
        const tense = f.status === "ACTIVE" ? "has served" : "served";
        return (
          `This is to certify that ${f.name} ${tense} at ${school} as ${f.jobTitle}${grade}${dept} ` +
          `from ${since} to ${f.endDate ? until : "the present day"}.\n\n` +
          `During this period they discharged their duties diligently. We wish them success in their future endeavours.`
        );
      }
    }
  }

  private render(t: LetterType, school: string, ref: string, f: LetterFacts, logo: Buffer | null): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 60 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Letterhead: best-effort logo + school name + rule.
      if (logo) {
        try {
          doc.image(logo, 60, 50, { fit: [56, 56] });
        } catch {
          /* a broken image must never block an official letter */
        }
      }
      doc.fontSize(20).text(school, logo ? 130 : 60, 62, { width: 400 });
      doc.moveTo(60, 120).lineTo(535, 120).lineWidth(1.5).stroke("#0f172a");

      doc.fontSize(10).fillColor("#444");
      doc.text(`Ref: ${ref}`, 60, 135);
      doc.text(`Date: ${new Date().toISOString().slice(0, 10)}`, 60, 150);

      doc.moveDown(3).fillColor("#000").fontSize(13).text(TITLES[t], 60, 190, { align: "center", underline: true });
      doc.moveDown(1.5).fontSize(11).text("TO WHOM IT MAY CONCERN", { align: "left" });
      doc.moveDown(1).fontSize(11).text(this.body(t, f, school), { align: "justify", lineGap: 4 });

      doc.moveDown(4);
      doc.text("Yours faithfully,", { lineGap: 2 });
      doc.moveDown(3);
      doc.moveTo(60, doc.y).lineTo(220, doc.y).lineWidth(0.8).stroke("#000");
      doc.moveDown(0.3).fontSize(10).text(`For: ${school} (Human Resources)`);
      doc
        .moveDown(3)
        .fontSize(8)
        .fillColor("#666")
        .text(
          `Verification: quote reference ${ref}. Generated by the School Management System; issuance is recorded in the school's audit log.`,
        );
      doc.end();
    });
  }
}
