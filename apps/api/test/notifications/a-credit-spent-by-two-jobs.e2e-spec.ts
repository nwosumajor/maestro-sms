// =============================================================================
// PROBE: two send jobs, one credit — does the school pay for two messages?
// =============================================================================
// A metered send (SMS / WhatsApp) takes an ALLOWANCE once per job:
//
//     allowance = await credits.balanceInTx(tx, schoolId)   // read
//     if (metered && remaining() <= 0) -> fail soft
//     if (metered) allowance = remaining() - 1              // LOCAL decrement
//     ... gateway send ...
//     await credits.debitInTx(...)                          // write, later
//
// The comment above it is right that an allowance stops two metered CHANNELS in
// ONE notification from both spending the last credit. It says nothing about two
// notifications: the BullMQ worker runs jobs concurrently, and a school
// broadcasting to many families produces many at once. Each job reads the same
// balance.
//
// Credits are BOUGHT — a bundle is a real payment — so overspending them bills
// the school for messages it did not buy and drives the ledger negative.
//
// Run: `pnpm --filter @sms/api test:db -- a-credit-spent-by-two-jobs`.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { NotificationService } from "../../src/notifications/notification.service";
import { MessageCreditsService } from "../../src/notifications/message-credits.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("one message credit, two concurrent send jobs (real Postgres)", () => {
  let admin: Pool;
  let svc: NotificationService;

  const SA = randomUUID();
  const STAFF = randomUUID();
  const N1 = randomUUID();
  const N2 = randomUUID();

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'MC',$2,now())`, [SA, "mc-" + SA]);
    await admin.query(
      `INSERT INTO "user" (id,"schoolId",email,name,phone,"passwordHash",status,"updatedAt")
       VALUES ($1,$2,$3,'Parent','+2348000000000','x','ACTIVE',now())`,
      [STAFF, SA, `${STAFF}@mc.test`],
    );
    // EXACTLY ONE credit — the school can afford one message, not two.
    await admin.query(
      `INSERT INTO message_credit_entry (id,"schoolId","deltaCredits",reason,"createdAt")
       VALUES (gen_random_uuid(),$1,1,'PURCHASE',now())`,
      [SA],
    );
    // Two notifications, each with one PENDING SMS delivery.
    for (const id of [N1, N2]) {
      await admin.query(
        `INSERT INTO notification (id,"schoolId","recipientId",type,title,body,"createdAt","updatedAt")
         VALUES ($1,$2,$3,'GENERAL','T','B',now(),now())`,
        [id, SA, STAFF],
      );
      await admin.query(
        `INSERT INTO notification_delivery (id,"schoolId","notificationId",channel,status,attempts,"createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,'SMS','PENDING',0,now(),now())`,
        [SA, id],
      );
    }

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    // A gateway that always succeeds: this probe is about the LEDGER, not the wire.
    // `deliver(req)`, which is what the provider interface declares — a double
    // carrying a plausible neighbour (`send`) leaves the row PENDING with
    // attempts=1 and no error, i.e. exactly the "handed to a gateway, outcome
    // lost" state, and the probe then passes having sent nothing.
    const channels = { deliver: jest.fn().mockResolvedValue({ ok: true, providerRef: "ref" }) };
    const credits = new MessageCreditsService(tenant, audit, { isConfigured: () => false } as never);
    svc = new NotificationService(tenant, audit, queue as never, channels as never, credits);
  });

  afterAll(async () => {
    for (const t of ["message_credit_entry", "notification_delivery", "notification", "audit_log", "\"user\"", "school"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]).catch(async () => {
        await admin.query(`DELETE FROM ${t} WHERE id = $1`, [SA]).catch(() => undefined);
      });
    }
    await admin.end();
    await prisma.$disconnect();
  });

  it("does not let two jobs spend the same last credit", async () => {
    // Promise.all: two workers picking up two notifications for one school at
    // the same moment. Sequentially the second correctly sees a zero balance
    // and fails soft.
    await Promise.allSettled([
      svc.runDeliveries({ schoolId: SA, userId: STAFF, notificationId: N1 }),
      svc.runDeliveries({ schoolId: SA, userId: STAFF, notificationId: N2 }),
    ]);

    const bal = await admin.query(
      `SELECT COALESCE(sum("deltaCredits"),0)::int AS balance FROM message_credit_entry WHERE "schoolId"=$1`,
      [SA],
    );
    const sent = await admin.query(
      `SELECT count(*)::int AS n FROM notification_delivery WHERE "schoolId"=$1 AND status='SENT'`,
      [SA],
    );
    // A bundle is a real payment; the ledger must never owe the school messages
    // it did not buy.
    const rows = await admin.query(
      `SELECT channel, status, attempts, COALESCE(error,'-') AS error FROM notification_delivery WHERE "schoolId"=$1`,
      [SA],
    );
    // eslint-disable-next-line no-console -- the measurement is the point
    console.log(`  balance=${bal.rows[0].balance} sent=${sent.rows[0].n}`, rows.rows);
    // EXACTLY one: `<= 1` also passes at ZERO, which is what a probe that sent
    // nothing at all looks like. A race that never reached the gateway proves
    // nothing about the ledger.
    expect(sent.rows[0].n).toBe(1);
    expect(bal.rows[0].balance).toBeGreaterThanOrEqual(0);
  });
});
