// =============================================================================
// CertificateService — ID-card + certificate PDF generator
// =============================================================================
// Tenant-scoped (RLS). Staff (certificate.issue) generate a templated PDF (pdfkit,
// like report cards/payslips) for a student/staff member: an ID card (name, unique
// id, school) or a certificate (completion/merit, with an optional custom title +
// body). Each issuance appends an immutable issued_certificate row (serial, who,
// what, when) for audit + reprint history. The PDF is built from CURRENT data.
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import PDFDocument from "pdfkit";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { BrandingService } from "../branding/branding.service";

const TYPES = ["ID_CARD", "COMPLETION", "PARTICIPATION", "MERIT"];

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
    const data = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const subject = await tx.user.findFirst({
        where: { id: input.subjectId },
        select: { id: true, name: true, email: true, uniqueId: true },
      });
      if (!subject) throw new NotFoundException("Subject not found in this school");
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } });
      const serial = `${input.type === "ID_CARD" ? "ID" : "CERT"}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
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
      await this.audit.record(
        { actorId: p.userId, action: "certificate.issue", entity: "issued_certificate", entityId: serial, schoolId: p.schoolId, metadata: { type: input.type, subjectId: input.subjectId } },
        tx,
      );
      return {
        subjectName: subject.name,
        uniqueId: subject.uniqueId,
        email: subject.email,
        schoolName: school?.name ?? "School",
        serial,
      };
    });

    // The school's uploaded logo (embedded into the document); null if unset.
    const logo = await this.branding.getLogoBytes(p.schoolId).catch(() => null);
    const buffer = input.type === "ID_CARD" ? await this.renderIdCard(data, logo) : await this.renderCertificate(input, data, logo);
    const filename = `${input.type.toLowerCase()}-${data.serial}.pdf`;
    return { buffer, filename };
  }

  /** Issuance history for a subject (audit/reprint). */
  async history(p: Principal, subjectId: string) {
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.issuedCertificate.findMany({ where: { subjectId }, orderBy: { createdAt: "desc" }, take: 100 }),
    );
  }

  // --- PDF templates --------------------------------------------------------

  /** Best-effort logo draw — a corrupt/unsupported image must never break the PDF. */
  private drawLogo(doc: InstanceType<typeof PDFDocument>, logo: Buffer | null | undefined, x: number, y: number, size: number): void {
    if (!logo) return;
    try {
      doc.image(logo, x, y, { fit: [size, size], align: "center", valign: "center" });
    } catch {
      /* ignore unsupported/corrupt image */
    }
  }

  private renderIdCard(d: { subjectName: string; uniqueId: string; schoolName: string; serial: string }, logo?: Buffer | null): Promise<Buffer> {
    // Standard ID-card size (CR80, landscape) at 72 dpi-ish.
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: [340, 215], margin: 16 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.rect(0, 0, 340, 40).fill("#1d4ed8");
      // School logo, top-right of the header band.
      this.drawLogo(doc, logo, 296, 6, 28);
      doc.fillColor("#ffffff").fontSize(14).text(d.schoolName, 16, 12, { width: 270 });
      doc.fillColor("#111111");
      doc.fontSize(16).text(d.subjectName, 16, 70);
      doc.fontSize(11).fillColor("#444444").text("Student / Staff ID", 16, 94);
      doc.fontSize(13).fillColor("#111111").text(d.uniqueId, 16, 120);
      doc.fontSize(8).fillColor("#888888").text(`Serial: ${d.serial}`, 16, 188);
      doc.end();
    });
  }

  private renderCertificate(
    input: { type: string; title?: string; body?: string },
    d: { subjectName: string; schoolName: string; serial: string },
    logo?: Buffer | null,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 50 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      const w = doc.page.width;
      doc.lineWidth(3).strokeColor("#1d4ed8").rect(25, 25, w - 50, doc.page.height - 50).stroke();
      // School logo, centred above the school name.
      if (logo) {
        this.drawLogo(doc, logo, w / 2 - 30, 45, 60);
        doc.moveDown(4);
      }
      doc.fillColor("#1d4ed8").fontSize(28).text(d.schoolName, { align: "center" });
      doc.moveDown(0.5);
      doc.fillColor("#111111").fontSize(22).text(input.title ?? "Certificate of Completion", { align: "center" });
      doc.moveDown(1.2);
      doc.fontSize(14).fillColor("#444444").text("This is to certify that", { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(26).fillColor("#111111").text(d.subjectName, { align: "center" });
      doc.moveDown(0.8);
      doc.fontSize(13).fillColor("#444444").text(
        input.body ?? "has successfully met the requirements and is hereby awarded this certificate.",
        { align: "center" },
      );
      doc.moveDown(2);
      doc.fontSize(9).fillColor("#888888").text(`Serial: ${d.serial}  ·  Issued: ${new Date().toLocaleDateString()}`, { align: "center" });
      doc.end();
    });
  }
}
