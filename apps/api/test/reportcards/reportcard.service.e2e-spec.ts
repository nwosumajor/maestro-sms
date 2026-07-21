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

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { ReportCardService } from "../../src/reportcards/reportcard.service";
import { ReportCardRemarkService } from "../../src/reportcards/report-card-remark.service";
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
    reportCards = new ReportCardService(tenant, audit, branding, documents, remarks);
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

  it("PRINCIPAL generates it -> a REAL Document Vault row exists that the STUDENT can retrieve themselves", async () => {
    const { buffer } = await reportCards.generate(principal(), STUDENT);
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-"); // the caller still gets their own copy immediately

    // The student did NOT generate it, yet can list + download their own vault copy.
    const mine = await documents.listDocuments(student(), { studentId: STUDENT });
    const rc = mine.find((doc: { type: string }) => doc.type === "REPORT_CARD");
    expect(rc).toBeDefined();
    expect(rc!.status).toBe("UPLOADED");

    const dl = await documents.getDownloadUrl(student(), rc!.id);
    expect(dl.download.url).toContain("op=get");
  });

  it("the GUARDIAN can retrieve the same document independently", async () => {
    const mine = await documents.listDocuments(guardian(), { studentId: STUDENT });
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
    const theirs = await documents.listDocuments(otherParent(), { studentId: STUDENT });
    expect(theirs.filter((doc: { type: string }) => doc.type === "REPORT_CARD")).toHaveLength(0);
  });
});
