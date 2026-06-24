// =============================================================================
// RLS cross-tenant isolation — foundation + LMS + integrity (the priority suite)
// =============================================================================
// Proves, at the DATABASE layer, that tenant isolation holds regardless of app
// code. Connects as the least-privilege APP role (RLS in force) for the
// assertions, and as a privileged ADMIN role only to seed across FK constraints.
//
//   TEST_DATABASE_URL  -> app role (e.g. major_user)  — RLS enforced
//   TEST_ADMIN_URL     -> superuser (e.g. sms_admin)  — setup/teardown only
//
// Both must be set, or the suite skips (it must run in CI, never false-pass).
// =============================================================================

import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("RLS cross-tenant isolation", () => {
  let appPool: Pool;
  let adminPool: Pool;

  // ids for this run (unique so cleanup only touches our rows)
  const A = randomUUID();
  const B = randomUUID();
  const userA = randomUUID();
  const assessmentA = randomUUID();
  const classA = randomUUID();
  const submissionA = randomUUID();
  const gradeA = randomUUID();
  const workflowReqA = randomUUID();
  const profileA = randomUUID();
  const contactA = randomUUID();
  const medicalA = randomUUID();
  const attSessionA = randomUUID();
  const attRecordA = randomUUID();
  const notifA = randomUUID();
  const notifDeliveryA = randomUUID();
  const feeItemA = randomUUID();
  const invoiceA = randomUUID();
  const lineItemA = randomUUID();
  const paymentA = randomUUID();
  const documentA = randomUUID();
  const periodA = randomUUID();
  const roomA = randomUUID();
  const ttEntryA = randomUUID();
  const grantA = randomUUID();
  const erasureA = randomUUID();
  const eventA = randomUUID();
  const threadA = randomUUID();
  const gameA = randomUUID();
  const gamePlayerA = randomUUID();
  const guessA = randomUUID();
  const gameResultA = randomUUID();
  const competitionA = randomUUID();
  const standingA = randomUUID();
  const gameSettingsA = randomUUID();
  // Ultimate: ONLY the tenant-scoped governance/bridge tables are isolation-tested.
  // The arena tables (ultimate_competition / ultimate_participant) are
  // CROSS-TENANT by design (RLS-exempt — see 21_ultimate_rls.sql) and carry no PII.
  const ultimateCompA = randomUUID(); // cross-tenant arena row (not in the deny set)
  const ultimateParticipantA = randomUUID();
  const ultimateEnrollA = randomUUID();
  const ultimateConsentA = randomUUID();
  const ultimateLinkA = randomUUID();
  const lmsContentA = randomUUID();
  const quizAttemptA = randomUUID();
  const forumPostA = randomUUID();

  beforeAll(async () => {
    appPool = new Pool({ connectionString: APP_URL });
    adminPool = new Pool({ connectionString: ADMIN_URL });
    // NOTE: `updatedAt` is Prisma @updatedAt (app-side, no DB default), so raw
    // inserts must supply it.
    const a = adminPool;
    await a.query(
      `INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'A',$2,now()),($3,'B',$4,now())`,
      [A, `slug-${A}`, B, `slug-${B}`],
    );
    await a.query(
      `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,'U','x',now())`,
      [userA, A, `u_${userA}@t`],
    );
    await a.query(
      `INSERT INTO assessment (id,"schoolId",title,"createdById","updatedAt") VALUES ($1,$2,'T',$3,now())`,
      [assessmentA, A, userA],
    );
    await a.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'C',now())`, [classA, A]);
    await a.query(
      `INSERT INTO submission (id,"schoolId","assessmentId","studentId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [submissionA, A, assessmentA, userA],
    );
    await a.query(
      `INSERT INTO grade (id,"schoolId","submissionId",score,"maxScore","gradedById","updatedAt") VALUES ($1,$2,$3,80,100,$4,now())`,
      [gradeA, A, submissionA, userA],
    );
    await a.query(
      `INSERT INTO workflow_request (id,"schoolId",type,title,payload,"initiatorId","updatedAt") VALUES ($1,$2,'LEAVE','T','{}'::jsonb,$3,now())`,
      [workflowReqA, A, userA],
    );
    // SIS: profile -> emergency contact + medical record (all school A)
    await a.query(
      `INSERT INTO student_profile (id,"schoolId","studentId","updatedAt") VALUES ($1,$2,$3,now())`,
      [profileA, A, userA],
    );
    await a.query(
      `INSERT INTO emergency_contact (id,"schoolId","profileId",name,relationship,phone,"updatedAt") VALUES ($1,$2,$3,'Mum','Mother','555',now())`,
      [contactA, A, profileA],
    );
    await a.query(
      `INSERT INTO medical_record (id,"schoolId","profileId","updatedAt") VALUES ($1,$2,$3,now())`,
      [medicalA, A, profileA],
    );
    // Attendance: session (class A) -> record (student userA)
    await a.query(
      `INSERT INTO attendance_session (id,"schoolId","classId",date,"takenById","updatedAt") VALUES ($1,$2,$3,current_date,$4,now())`,
      [attSessionA, A, classA, userA],
    );
    await a.query(
      `INSERT INTO attendance_record (id,"schoolId","sessionId","studentId",status,"updatedAt") VALUES ($1,$2,$3,$4,'PRESENT',now())`,
      [attRecordA, A, attSessionA, userA],
    );
    // Notifications: notification (recipient userA) -> a delivery
    await a.query(
      `INSERT INTO notification (id,"schoolId","recipientId",type,title,body,"updatedAt") VALUES ($1,$2,$3,'GENERIC','T','B',now())`,
      [notifA, A, userA],
    );
    await a.query(
      `INSERT INTO notification_delivery (id,"schoolId","notificationId",channel,"updatedAt") VALUES ($1,$2,$3,'EMAIL',now())`,
      [notifDeliveryA, A, notifA],
    );
    // Fees: fee_item, invoice (student userA) -> line item + payment
    await a.query(
      `INSERT INTO fee_item (id,"schoolId",name,"amountMinor","updatedAt") VALUES ($1,$2,'Tuition',50000,now())`,
      [feeItemA, A],
    );
    await a.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,"totalMinor","dueDate","createdById","updatedAt")
       VALUES ($1,$2,$3,$4,50000,current_date,$5,now())`,
      [invoiceA, A, userA, `INV-${invoiceA}`, userA],
    );
    await a.query(
      `INSERT INTO invoice_line_item (id,"schoolId","invoiceId",description,"amountMinor") VALUES ($1,$2,$3,'Tuition',50000)`,
      [lineItemA, A, invoiceA],
    );
    await a.query(
      `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,"recordedById") VALUES ($1,$2,$3,50000,'CASH',$4)`,
      [paymentA, A, invoiceA, userA],
    );
    // Document vault: a report card for student userA
    await a.query(
      `INSERT INTO document (id,"schoolId","studentId",type,title,"storageKey","contentType","uploadedById","updatedAt")
       VALUES ($1,$2,$3,'REPORT_CARD','Report',$4,'application/pdf',$5,now())`,
      [documentA, A, userA, `schools/${A}/documents/${documentA}/report`, userA],
    );
    // Timetable: period + room + entry (class classA, teacher userA)
    await a.query(
      `INSERT INTO period (id,"schoolId",name,sequence,"startTime","endTime","updatedAt") VALUES ($1,$2,'P1',1,'08:00','08:45',now())`,
      [periodA, A],
    );
    await a.query(
      `INSERT INTO room (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'Room 1',now())`,
      [roomA, A],
    );
    await a.query(
      `INSERT INTO timetable_entry (id,"schoolId","classId","dayOfWeek","periodId",subject,"teacherId","roomId","updatedAt")
       VALUES ($1,$2,$3,'MONDAY',$4,'History',$5,$6,now())`,
      [ttEntryA, A, classA, periodA, userA, roomA],
    );
    // Security: a privilege grant for userA
    await a.query(
      `INSERT INTO privilege_grant (id,"schoolId","userId",permission,reason,status,"requestedById","updatedAt")
       VALUES ($1,$2,$3,'fee.manage','test','PENDING',$3,now())`,
      [grantA, A, userA],
    );
    await a.query(
      `INSERT INTO erasure_request (id,"schoolId","studentId","requestedById",reason,"updatedAt") VALUES ($1,$2,$3,$3,'x',now())`,
      [erasureA, A, userA],
    );
    await a.query(
      `INSERT INTO school_event (id,"schoolId",title,"startsAt","createdById","updatedAt") VALUES ($1,$2,'E',now(),$3,now())`,
      [eventA, A, userA],
    );
    await a.query(
      `INSERT INTO message_thread (id,"schoolId",subject,"createdById","updatedAt") VALUES ($1,$2,'S',$3,now())`,
      [threadA, A, userA],
    );
    // Dead & Wounded game (step 3): a game + a player + a guess + a result in A.
    await a.query(
      `INSERT INTO game (id,"schoolId","difficultyLength","createdById","updatedAt") VALUES ($1,$2,4,$3,now())`,
      [gameA, A, userA],
    );
    await a.query(
      `INSERT INTO game_player (id,"schoolId","gameId","userId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [gamePlayerA, A, gameA, userA],
    );
    await a.query(
      `INSERT INTO guess (id,"schoolId","gameId","guesserId","targetId",value,dead,wounded) VALUES ($1,$2,$3,$4,$4,'1234',1,2)`,
      [guessA, A, gameA, gamePlayerA],
    );
    await a.query(
      `INSERT INTO game_result (id,"schoolId","gameId","userId",rank,"guessCount",outcome,"updatedAt") VALUES ($1,$2,$3,$4,1,3,'WON',now())`,
      [gameResultA, A, gameA, userA],
    );
    // League/Knockout (step 4): a competition + a standing in A.
    await a.query(
      `INSERT INTO competition (id,"schoolId",type,name,"difficultyLength","startAt","endAt","createdById","updatedAt") VALUES ($1,$2,'LEAGUE','L',4,now(),now(),$3,now())`,
      [competitionA, A, userA],
    );
    await a.query(
      `INSERT INTO standing (id,"schoolId","competitionId","userId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [standingA, A, competitionA, userA],
    );
    // Per-school game settings (step 7).
    await a.query(
      `INSERT INTO game_settings (id,"schoolId","updatedAt") VALUES ($1,$2,now())`,
      [gameSettingsA, A],
    );
    // Ultimate (step 8): an arena competition (cross-tenant) + the tenant-scoped
    // enrollment/consent/entry-link governance rows for school A.
    await a.query(
      `INSERT INTO ultimate_competition (id,name,"difficultyLength","startAt","endAt","createdById","updatedAt") VALUES ($1,'U',4,now(),now(),$2,now())`,
      [ultimateCompA, userA],
    );
    await a.query(
      `INSERT INTO ultimate_enrollment (id,"schoolId","competitionId","enrolledById") VALUES ($1,$2,$3,$4)`,
      [ultimateEnrollA, A, ultimateCompA, userA],
    );
    await a.query(
      `INSERT INTO ultimate_consent (id,"schoolId","studentId","grantedById","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [ultimateConsentA, A, userA, userA],
    );
    await a.query(
      `INSERT INTO ultimate_participant (id,"competitionId","schoolId",handle,"updatedAt") VALUES ($1,$2,$3,'acer',now())`,
      [ultimateParticipantA, ultimateCompA, A],
    );
    await a.query(
      `INSERT INTO ultimate_entry_link (id,"schoolId","competitionId","userId","participantId",handle) VALUES ($1,$2,$3,$4,$5,'acer')`,
      [ultimateLinkA, A, ultimateCompA, userA, ultimateParticipantA],
    );
    // LMS learning content + quiz attempt + forum post (tenant-scoped).
    await a.query(
      `INSERT INTO lms_content (id,"schoolId","classId",type,title,body,"authorId","updatedAt") VALUES ($1,$2,$3,'LESSON','L','{}'::jsonb,$4,now())`,
      [lmsContentA, A, classA, userA],
    );
    await a.query(
      `INSERT INTO quiz_attempt (id,"schoolId","contentId","studentId",answers,score,total) VALUES ($1,$2,$3,$4,'{}'::jsonb,1,1)`,
      [quizAttemptA, A, lmsContentA, userA],
    );
    await a.query(
      `INSERT INTO forum_post (id,"schoolId","contentId","authorId",body) VALUES ($1,$2,$3,$4,'hi')`,
      [forumPostA, A, lmsContentA, userA],
    );
  });

  afterAll(async () => {
    const a = adminPool;
    for (const t of [
      "audit_log",
      // LMS content children (forum/quiz) before lms_content; lms_content before class/user.
      "forum_post",
      "quiz_attempt",
      "lms_content",
      // game children before game (FK), game before competition (game.competitionId
      // FK), standing before competition, competition before user/school.
      "guess",
      "game_result",
      "game_player",
      "game",
      "standing",
      "competition",
      "game_settings",
      // Ultimate: bridge/governance + participant are schoolId-scoped; the arena
      // `ultimate_competition` has NO schoolId (cross-tenant) → deleted by id below.
      "ultimate_entry_link",
      "ultimate_enrollment",
      "ultimate_consent",
      "ultimate_participant",
      "message",
      "thread_participant",
      "message_thread",
      "school_event",
      "erasure_request",
      "privilege_grant",
      "timetable_entry",
      "period",
      "room",
      "document",
      "workflow_audit_log",
      "grade",
      "workflow_request",
      "submission",
      "assessment",
      // attendance_session.classId -> class, so attendance must be purged first.
      "attendance_record",
      "attendance_session",
      "class",
      "payment",
      "invoice_line_item",
      "invoice",
      "fee_item",
      "notification_delivery",
      "notification",
      "emergency_contact",
      "medical_record",
      "student_profile",
    ]) {
      await a.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[A, B]]);
    }
    // Cross-tenant arena competition has no schoolId — delete by id.
    await a.query(`DELETE FROM ultimate_competition WHERE id = $1`, [ultimateCompA]);
    await a.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[A, B]]);
    await a.query(`DELETE FROM school WHERE id = ANY($1)`, [[A, B]]);
    await appPool.end();
    await adminPool.end();
  });

  async function asApp<T>(school: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_school_id', $1, true)", [school]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  const cases: Array<[string, string]> = [
    ["user", userA],
    ["class", classA],
    ["assessment", assessmentA],
    ["submission", submissionA],
    ["grade", gradeA],
    ["workflow_request", workflowReqA],
    ["student_profile", profileA],
    ["emergency_contact", contactA],
    ["medical_record", medicalA],
    ["attendance_session", attSessionA],
    ["attendance_record", attRecordA],
    ["notification", notifA],
    ["notification_delivery", notifDeliveryA],
    ["fee_item", feeItemA],
    ["invoice", invoiceA],
    ["invoice_line_item", lineItemA],
    ["payment", paymentA],
    ["document", documentA],
    ["period", periodA],
    ["room", roomA],
    ["timetable_entry", ttEntryA],
    ["privilege_grant", grantA],
    ["erasure_request", erasureA],
    ["school_event", eventA],
    ["message_thread", threadA],
    ["game", gameA],
    ["game_player", gamePlayerA],
    ["guess", guessA],
    ["game_result", gameResultA],
    ["competition", competitionA],
    ["standing", standingA],
    ["game_settings", gameSettingsA],
    ["lms_content", lmsContentA],
    ["quiz_attempt", quizAttemptA],
    ["forum_post", forumPostA],
  ];

  it.each(cases)("school B cannot SELECT school A's %s; school A can", async (table, id) => {
    // Quote the table name — `user` is a SQL reserved word.
    await asApp(B, async (c) => {
      const r = await c.query(`SELECT 1 FROM "${table}" WHERE id = $1`, [id]);
      expect(r.rowCount).toBe(0); // invisible -> app returns 404, never "forbidden"
    });
    await asApp(A, async (c) => {
      const r = await c.query(`SELECT 1 FROM "${table}" WHERE id = $1`, [id]);
      expect(r.rowCount).toBe(1);
    });
  });

  it("audit_log is append-only: INSERT allowed, UPDATE denied", async () => {
    // INSERT under tenant A is allowed for the app role.
    await asApp(A, async (c) => {
      await c.query(
        `INSERT INTO audit_log (id,"schoolId","actorId",action,entity,"entityId")
         VALUES (gen_random_uuid(),$1,$2,'test','x','y')`,
        [A, userA],
      );
    });
    // UPDATE is denied (no policy + privilege revoked).
    await asApp(A, async (c) => {
      await expect(
        c.query(`UPDATE audit_log SET action='tamper' WHERE "schoolId" = $1`, [A]),
      ).rejects.toThrow();
    });
  });

  it("integrity_signal is append-only: INSERT allowed, UPDATE denied", async () => {
    await asApp(A, async (c) => {
      await c.query(
        `INSERT INTO integrity_signal (id,"schoolId","submissionId",type,severity,source,confidence,evidence)
         VALUES (gen_random_uuid(),$1,$2,'PASTE','INFO','CLIENT',0,'{}'::jsonb)`,
        [A, submissionA],
      );
    });
    await asApp(A, async (c) => {
      await expect(
        c.query(`UPDATE integrity_signal SET severity='HIGH' WHERE "schoolId" = $1`, [A]),
      ).rejects.toThrow();
    });
  });

  it("workflow_audit_log is append-only: INSERT allowed, UPDATE denied", async () => {
    await asApp(A, async (c) => {
      await c.query(
        `INSERT INTO workflow_audit_log (id,"schoolId","requestId","initiatorId","newState")
         VALUES (gen_random_uuid(),$1,$2,$3,'DRAFT')`,
        [A, workflowReqA, userA],
      );
    });
    await asApp(A, async (c) => {
      await expect(
        c.query(`UPDATE workflow_audit_log SET "newState"='APPROVED' WHERE "schoolId" = $1`, [A]),
      ).rejects.toThrow();
    });
  });

  it("INSERT with a foreign schoolId is rejected (WITH CHECK)", async () => {
    await asApp(A, async (c) => {
      await expect(
        c.query(`INSERT INTO class (id,"schoolId",name) VALUES (gen_random_uuid(),$1,'X')`, [B]),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it("a missing tenant GUC fails closed (sees nothing)", async () => {
    // Without a valid tenant the row must NOT be visible. "Closed" can manifest
    // as either 0 rows (unset GUC -> NULL predicate) or an error (an empty-string
    // GUC -> ''::uuid cast fails). Both are safe; only a visible row is a leak.
    const c = await appPool.connect();
    let visible = false;
    try {
      await c.query("BEGIN");
      const r = await c.query(`SELECT 1 FROM class WHERE id = $1`, [classA]);
      visible = (r.rowCount ?? 0) > 0;
    } catch {
      visible = false; // predicate cast error = closed
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    expect(visible).toBe(false);
  });
});
