import { GRADE_COMPONENTS } from "@sms/types";
// =============================================================================
// ReportCardService — Document Vault persistence integration (real DB)
// =============================================================================
// Proves the fix for a real gap: generating a report card used to stream the
// PDF ONLY to whoever called it — if a PRINCIPAL generated a student's report
// card, the student/parent had no way to retrieve it themselves (the guardian
// notification claimed one was "ready" but nothing existed for them to open).
// Now generate() ALSO persists into the Document Vault (type REPORT_CARD), so:
//   - staff generating it creates a REAL, independently retrievable document
//   - the STUDENT can list/download it themselves afterwards (self-scoped)
//   - the guardian gets notified only once real bytes are behind the alert
//   - a parent NOT linked to the student never sees it (cross-family isolation)
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma
// singleton) + TEST_ADMIN_URL (superuser, to seed). Skips otherwise.
// =============================================================================

import zlib from "node:zlib";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { ReportCardService } from "../../src/reportcards/reportcard.service";
import { ReportCardRemarkService } from "../../src/reportcards/report-card-remark.service";
import { TermResultService } from "../../src/gradebook/term-result.service";
import { DocumentsService } from "../../src/documents/documents.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { BrandingService } from "../../src/branding/branding.service";
import { StubStorageProvider } from "../../src/documents/storage.provider";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

/**
 * The visible text of a PDFKit document — the same inflate-and-glue the
 * `reportcard-pdf` suite uses, kept here so a card's CONTENT can be asserted
 * against a real database rather than against a hand-built argument.
 */
function pdfText(pdf: Buffer): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const s = pdf.indexOf("\nstream", i);
    if (s === -1) break;
    let from = s + 7;
    while (pdf[from] === 0x0d || pdf[from] === 0x0a) from += 1;
    const e = pdf.indexOf("endstream", from);
    if (e === -1) break;
    i = e + 9;
    let raw: string;
    try {
      raw = zlib.inflateSync(pdf.subarray(from, e)).toString("latin1");
    } catch {
      continue; // fonts and images are not deflated content streams
    }
    // PDFKit splits one line into several hex runs wherever the font kerns, so
    // the runs are glued back together before anything is searched for.
    let line = "";
    for (const m of raw.matchAll(/\[((?:<[0-9A-Fa-f]*>|[-\d.\s])*)\]\s*TJ|\((?:[^()\\]|\\.)*\)\s*Tj/g)) {
      const chunk = m[0];
      for (const hex of chunk.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        line += (hex[1].match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join("");
      }
      for (const lit of chunk.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) line += lit[1];
    }
    if (line) out.push(line);
    out.push(raw.replace(/[^\x20-\x7e]+/g, " "));
  }
  return out.join("\n");
}

d("ReportCardService generate() persists to the Document Vault (real Postgres)", () => {
  let admin: Pool;
  let reportCards: ReportCardService;
  let documents: DocumentsService;

  const SA = randomUUID();
  const PRINCIPAL = randomUUID();
  const STUDENT = randomUUID();
  const GUARDIAN = randomUUID(); // linked to STUDENT
  const OTHER_PARENT = randomUUID(); // NOT linked — must never see it

  const principal = (): Principal => ({ userId: PRINCIPAL, schoolId: SA, roles: ["principal"], permissions: [] });
  const student = (): Principal => ({ userId: STUDENT, schoolId: SA, roles: ["student"], permissions: [] });
  const guardian = (): Principal => ({ userId: GUARDIAN, schoolId: SA, roles: ["parent"], permissions: [] });
  const otherParent = (): Principal => ({ userId: OTHER_PARENT, schoolId: SA, roles: ["parent"], permissions: [] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'RC',$2,now())`, [SA, "rc-" + SA]);
    for (const [u, name] of [
      [PRINCIPAL, "Principal"],
      [STUDENT, "The Student"],
      [GUARDIAN, "The Guardian"],
      [OTHER_PARENT, "Unrelated Parent"],
    ] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, SA, u + "@rc", name],
      );
    }
    await admin.query(
      `INSERT INTO parent_child (id,"schoolId","parentId","studentId") VALUES ($1,$2,$3,$4)`,
      [randomUUID(), SA, GUARDIAN, STUDENT],
    );

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const storage = new StubStorageProvider();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, audit, queue as never);
    documents = new DocumentsService(tenant, audit, storage, notifications);
    const branding = new BrandingService(tenant, audit, storage);
    const remarks = new ReportCardRemarkService(tenant, audit);
    const workflow = { createRequest: jest.fn(), submit: jest.fn() } as never;
    const hooks = { onFinalized: jest.fn() } as never;
    const region = { academicInTx: async () => ({ calendarTemplate: "THREE_TERM", grading: { components: GRADE_COMPONENTS } }), academicForSchool: async () => ({ calendarTemplate: "THREE_TERM", grading: { components: GRADE_COMPONENTS } }) } as never;
    const termResults = new TermResultService(tenant, audit, workflow, hooks, region);
    reportCards = new ReportCardService(tenant, audit, branding, documents, remarks, termResults, region);
  });

  afterAll(async () => {
    for (const t of ["document", "notification_delivery", "notification", "parent_child", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    // The app-role Prisma singleton must be closed or the jest worker hangs
    // on its open pool (CI runs workers in parallel — nobody else closes it).
    await prisma.$disconnect();
  });

  // =========================================================================
  // THE ONLY CARDS CARRYING A PROMOTION LINE WERE THE ONES WITH BAD NEWS
  // =========================================================================
  // The report card is where a family learns the end-of-session outcome — the
  // platform sends no notification for it, deliberately, because the card is
  // the artefact designed to carry it.
  //
  // The lookup filtered on `sourceClassId: enrolment.classId`, and `enrolment`
  // is the pupil's ACTIVE one. Approving a promotion marks the source enrolment
  // PROMOTED and opens a new ACTIVE one in the TARGET class — so for a pupil who
  // WAS promoted the source class no longer matched and the line never printed.
  // A pupil who was RETAINED stays ACTIVE in the source class, so theirs did.
  //
  // Measured live on a real batch of 30: the retained pupil's card read "TO
  // REPEAT THE CLASS" and all 29 promoted cards said nothing at all. A DEMOTE
  // moves the pupil too, so it was silent for the same reason.
  //
  // The PDF suite already covers `promotionLine` — it renders whatever it is
  // handed. The defect was in COMPUTING it, so this drives the real query
  // against a real database: a test on the view proves nothing about the lookup.
  describe("the end-of-session decision on the card", () => {
    const SOURCE = randomUUID();
    const TARGET = randomUUID();
    const SESSION = randomUUID();
    const TERM = randomUUID();

    beforeAll(async () => {
      await admin.query(`INSERT INTO class (id,"schoolId",name,code,"updatedAt") VALUES ($1,$2,'JSS1 A',$3,now()),($4,$2,'JSS2 A',$5,now())`, [SOURCE, SA, "s-" + SOURCE.slice(0, 8), TARGET, "t-" + TARGET.slice(0, 8)]);
      await admin.query(`INSERT INTO academic_session (id,"schoolId",name,"isCurrent","updatedAt") VALUES ($1,$2,'2026/2027',true,now())`, [SESSION, SA]);
      await admin.query(
        `INSERT INTO term (id,"schoolId","sessionId",name,sequence,"isCurrent","startDate","endDate","updatedAt")
         VALUES ($1,$2,$3,'Third Term',3,true,now() - interval '80 days', now() - interval '1 day', now())`,
        [TERM, SA, SESSION],
      );
      // The pupil has MOVED: their source enrolment is PROMOTED and their live
      // one is in the target class — exactly what approval leaves behind.
      await admin.query(`INSERT INTO enrollment (id,"schoolId","classId","studentId",status) VALUES ($1,$2,$3,$4,'PROMOTED'),($5,$2,$6,$4,'ACTIVE')`, [randomUUID(), SA, SOURCE, STUDENT, randomUUID(), TARGET]);
      await admin.query(
        `INSERT INTO promotion_batch (id,"schoolId","termId","sourceClassId","targetClassId","studentIds",decisions,status,"initiatedById","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'APPROVED',$8,now())`,
        [randomUUID(), SA, TERM, SOURCE, TARGET, JSON.stringify([STUDENT]), JSON.stringify([]), PRINCIPAL],
      );
    });

    afterAll(async () => {
      for (const t of ["promotion_batch", "enrollment", "term", "academic_session", "class"]) {
        await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
      }
    });

    it("tells a PROMOTED pupil they were promoted, though they have left the source class", async () => {
      const { buffer } = await reportCards.generate(principal(), STUDENT, TERM);
      expect(pdfText(buffer)).toContain("PROMOTED TO JSS2 A");
    });

    it("still tells a RETAINED pupil, who never moved", async () => {
      await admin.query(`UPDATE promotion_batch SET decisions = $2::jsonb WHERE "schoolId" = $1`, [
        SA,
        JSON.stringify([{ studentId: STUDENT, outcome: "RETAIN" }]),
      ]);
      const { buffer } = await reportCards.generate(principal(), STUDENT, TERM);
      expect(pdfText(buffer)).toContain("TO REPEAT THE CLASS");
    });

    it("tells a DEMOTED pupil, who moved DOWN and was silent for the same reason", async () => {
      await admin.query(`UPDATE promotion_batch SET decisions = $2::jsonb WHERE "schoolId" = $1`, [
        SA,
        JSON.stringify([{ studentId: STUDENT, outcome: "DEMOTE", targetClassId: SOURCE }]),
      ]);
      const { buffer } = await reportCards.generate(principal(), STUDENT, TERM);
      expect(pdfText(buffer)).toContain("TRANSFERRED TO A LOWER CLASS");
    });

    it("says NOTHING while the batch is only staged — an approval is what decides", async () => {
      await admin.query(`UPDATE promotion_batch SET status = 'PENDING' WHERE "schoolId" = $1`, [SA]);
      const { buffer } = await reportCards.generate(principal(), STUDENT, TERM);
      const t = pdfText(buffer);
      expect(t).not.toContain("PROMOTED TO");
      expect(t).not.toContain("TO REPEAT THE CLASS");
      expect(t).not.toContain("TRANSFERRED TO A LOWER CLASS");
    });

    it("says nothing about a pupil the batch never named", async () => {
      // An absent line is honest; a computed one would be the system awarding a
      // year it has no standing to award.
      await admin.query(`UPDATE promotion_batch SET status = 'APPROVED', "studentIds" = '[]'::jsonb WHERE "schoolId" = $1`, [SA]);
      const { buffer } = await reportCards.generate(principal(), STUDENT, TERM);
      expect(pdfText(buffer)).not.toContain("PROMOTED TO");
    });
  });

  it("PRINCIPAL generates it -> a REAL Document Vault row exists that the STUDENT can retrieve themselves", async () => {
    const { buffer } = await reportCards.generate(principal(), STUDENT);
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-"); // the caller still gets their own copy immediately

    // The student did NOT generate it, yet can list + download their own vault copy.
    const mine = (await documents.listDocuments(student(), { studentId: STUDENT }))
      .items as Array<{ id: string; type: string; status: string }>;
    const rc = mine.find((doc: { type: string }) => doc.type === "REPORT_CARD");
    expect(rc).toBeDefined();
    expect(rc!.status).toBe("UPLOADED");

    const dl = await documents.getDownloadUrl(student(), rc!.id);
    // The OPERATION IS INSIDE THE SIGNATURE, not a query parameter — that is
    // what stops "serve this inline" being switched on by editing the URL. This
    // asserted `op=get` and had been failing since the signing changed, unseen
    // because the whole suite skips without a database.
    expect(dl.download.url).toContain("/local-storage/");
    expect(dl.download.url).toMatch(/[?&]sig=[0-9a-f]{64}/);
    expect(dl.download.url).toMatch(/[?&]exp=\d+/);
    expect(dl.download.url).not.toContain("op=");
  });

  it("the GUARDIAN can retrieve the same document independently", async () => {
    const mine = (await documents.listDocuments(guardian(), { studentId: STUDENT }))
      .items as Array<{ type: string }>;
    expect(mine.some((doc: { type: string }) => doc.type === "REPORT_CARD")).toBe(true);
  });

  it("notifies the guardian only AFTER the vault copy is confirmed uploaded", async () => {
    const notif = await admin.query(
      `SELECT title FROM notification WHERE "recipientId" = $1 AND type = 'DOCUMENT_AVAILABLE'`,
      [GUARDIAN],
    );
    expect(notif.rowCount).toBeGreaterThan(0);
  });

  it("an UNRELATED parent never sees it (404-not-403 cross-family isolation)", async () => {
    const theirs = (await documents.listDocuments(otherParent(), { studentId: STUDENT }))
      .items as Array<{ type: string }>;
    expect(theirs.filter((doc: { type: string }) => doc.type === "REPORT_CARD")).toHaveLength(0);
  });
});
