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
  const lmsProgressA = randomUUID();
  const lmsSubmissionA = randomUUID();
  const lmsModuleA = randomUUID();
  const lmsContentRevisionA = randomUUID();
  const liveSessionA = randomUUID();
  const liveAttendanceA = randomUUID();
  const lmsAwardA = randomUUID();
  const xapiStatementA = randomUUID();
  const subPaymentA = randomUUID();
  // HR + the remaining tenant tables — seeded so the coverage meta-test
  // ("every RLS-enabled table has a deny case") holds for the whole schema.
  const employeeA = randomUUID();
  const classTeacherA = randomUUID();
  const enrollmentA = randomUUID();
  const parentChildA = randomUUID();
  const userRoleA = randomUUID();
  const roleX = randomUUID(); // a global role row to satisfy user_role.roleId FK
  const integrityConsentA = randomUUID();
  const retentionRunA = randomUUID();
  const messageA = randomUUID();
  const schoolSubA = randomUUID();
  const exemptionA = randomUUID();
  const draftA = randomUUID();
  const telemetryA = randomUUID();
  const threadParticipantA = randomUUID();
  const admissionA = randomUUID();
  const schoolBrandingA = randomUUID();
  const subjectA = randomUUID();
  const classSubjectA = randomUUID();
  const importBatchA = randomUUID();
  const parentImportBatchA = randomUUID();
  const promotionBatchA = randomUUID();
  const sessionA = randomUUID();
  const termA = randomUUID();
  const subjectResultA = randomUUID();
  const subjectSelectionA = randomUUID();
  const scholarshipApplicationA = randomUUID();
  const announcementA = randomUUID();
  // Hostel
  const hostelA = randomUUID();
  const hostelRoomA = randomUUID();
  const hostelAllocationA = randomUUID();
  // Transport
  const vehicleA = randomUUID();
  const transportRouteA = randomUUID();
  const routeStopA = randomUUID();
  const transportAssignmentA = randomUUID();
  // Library
  const libraryBookA = randomUUID();
  const bookLoanA = randomUUID();
  // Task
  const taskA = randomUUID();
  const taskAssignmentA = randomUUID();
  const taskCommentA = randomUUID();
  // Poll
  const pollA = randomUUID();
  const pollOptionA = randomUUID();
  const pollVoteA = randomUUID();
  // Discussion
  const discussionGroupA = randomUUID();
  const discussionPostA = randomUUID();
  const discussionCommentA = randomUUID();
  // Discipline
  const disciplineComplaintA = randomUUID();
  const disciplineAssigneeA = randomUUID();
  const disciplineEvidenceA = randomUUID();
  const disciplineEntryA = randomUUID();
  // Certificate
  const issuedCertificateA = randomUUID();
  // Alumni + Form
  const alumnusA = randomUUID();
  const formA = randomUUID();
  const formResponseA = randomUUID();
  // HR recruitment
  const jobReqA = randomUUID();
  const applicantA = randomUUID();
  // HR appraisals / disciplinary
  const appraisalA = randomUUID();
  const disciplinaryCaseA = randomUUID();
  const disciplinaryEntryA = randomUUID();
  // HR staff lifecycle
  const staffChecklistA = randomUUID();
  const staffChecklistItemA = randomUUID();
  const staffDocumentA = randomUUID();
  const trainingRecordA = randomUUID();
  // HR leave / salary / payroll
  const leaveTypeA = randomUUID();
  const leaveBalanceA = randomUUID();
  const leaveReqA = randomUUID();
  const salaryChangeA = randomUUID();
  const payrollRunA = randomUUID();
  const payslipA = randomUUID();

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
    await a.query(
      `INSERT INTO lms_progress (id,"schoolId","contentId","studentId",status,"updatedAt") VALUES ($1,$2,$3,$4,'COMPLETED',now())`,
      [lmsProgressA, A, lmsContentA, userA],
    );
    await a.query(
      `INSERT INTO lms_submission (id,"schoolId","contentId","studentId",text,status,"updatedAt") VALUES ($1,$2,$3,$4,'my work','SUBMITTED',now())`,
      [lmsSubmissionA, A, lmsContentA, userA],
    );
    await a.query(
      `INSERT INTO lms_module (id,"schoolId","classId",title,"updatedAt") VALUES ($1,$2,$3,'Module 1',now())`,
      [lmsModuleA, A, classA],
    );
    await a.query(
      `INSERT INTO lms_content_revision (id,"schoolId","contentId",version,type,title,"authorId") VALUES ($1,$2,$3,1,'LESSON','v1',$4)`,
      [lmsContentRevisionA, A, lmsContentA, userA],
    );
    await a.query(
      `INSERT INTO lms_live_session (id,"schoolId","classId",title,provider,"joinUrl","startsAt","hostId","updatedAt") VALUES ($1,$2,$3,'Live','JITSI','https://meet.jit.si/x',now(),$4,now())`,
      [liveSessionA, A, classA, userA],
    );
    await a.query(
      `INSERT INTO lms_live_attendance (id,"schoolId","sessionId","studentId") VALUES ($1,$2,$3,$4)`,
      [liveAttendanceA, A, liveSessionA, userA],
    );
    await a.query(
      `INSERT INTO lms_award (id,"schoolId","classId","studentId",badge,"awardedById") VALUES ($1,$2,$3,$4,'QUIZ_MASTER',$5)`,
      [lmsAwardA, A, classA, userA, userA],
    );
    await a.query(
      `INSERT INTO xapi_statement (id,"schoolId","actorId",verb,"objectId","objectName","classId") VALUES ($1,$2,$3,'completed','content:x','Intro',$4)`,
      [xapiStatementA, A, userA, classA],
    );
    // Platform billing: an append-only subscription payment for school A.
    await a.query(
      `INSERT INTO platform_subscription_payment
         (id,"schoolId",plan,"billingCycle",seats,"amountMinor",reference,status,"initiatedById","updatedAt")
       VALUES ($1,$2,'STANDARD','TERM',1,1000,$3,'PENDING',$4,now())`,
      [subPaymentA, A, `SUBR-${subPaymentA}`, userA],
    );
    // HR: an employment record for staff userA.
    await a.query(
      `INSERT INTO employee (id,"schoolId","userId","jobTitle","startDate","updatedAt") VALUES ($1,$2,$3,'Teacher',current_date,now())`,
      [employeeA, A, userA],
    );
    // LMS relationship/junction rows (class membership + teaching + guardianship).
    await a.query(
      `INSERT INTO class_teacher (id,"schoolId","classId","teacherId") VALUES ($1,$2,$3,$4)`,
      [classTeacherA, A, classA, userA],
    );
    // Subjects: a catalog subject + a class subject/teacher offering.
    await a.query(
      `INSERT INTO subject (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'Mathematics',now())`,
      [subjectA, A],
    );
    await a.query(
      `INSERT INTO class_subject_teacher (id,"schoolId","classId","subjectId","teacherId") VALUES ($1,$2,$3,$4,$5)`,
      [classSubjectA, A, classA, subjectA, userA],
    );
    // Bulk SIS import batch (maker-checker; uploaded by userA).
    await a.query(
      `INSERT INTO student_import_batch (id,"schoolId","uploadedById",rows,"updatedAt") VALUES ($1,$2,$3,'[]'::jsonb,now())`,
      [importBatchA, A, userA],
    );
    // Bulk PARENT import batch (maker-checker; uploaded by userA).
    await a.query(
      `INSERT INTO parent_import_batch (id,"schoolId","uploadedById",rows,"updatedAt") VALUES ($1,$2,$3,'[]'::jsonb,now())`,
      [parentImportBatchA, A, userA],
    );
    // Promotion batch (maker-checker; source classA, no target = graduation).
    await a.query(
      `INSERT INTO promotion_batch (id,"schoolId","sourceClassId","studentIds","initiatedById","updatedAt") VALUES ($1,$2,$3,'[]'::jsonb,$4,now())`,
      [promotionBatchA, A, classA, userA],
    );
    // Academic calendar: a session + a term.
    await a.query(
      `INSERT INTO academic_session (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'2025/2026',now())`,
      [sessionA, A],
    );
    await a.query(
      `INSERT INTO term (id,"schoolId","sessionId",name,sequence,"updatedAt") VALUES ($1,$2,$3,'First Term',1,now())`,
      [termA, A, sessionA],
    );
    // Term-weighted subject result (student userA, subjectA, termA/sessionA).
    await a.query(
      `INSERT INTO subject_result (id,"schoolId","sessionId","termId","classId","subjectId","studentId",exam,total,grade,status,"updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,80,48,'D','DRAFT',now())`,
      [subjectResultA, A, sessionA, termA, classA, subjectA, userA],
    );
    // Per-term subject selection (student userA picking subjectA).
    await a.query(
      `INSERT INTO subject_selection (id,"schoolId","sessionId","termId","classId","studentId","subjectIds","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now())`,
      [subjectSelectionA, A, sessionA, termA, classA, userA, JSON.stringify([subjectA])],
    );
    // School announcement (created by userA).
    await a.query(
      `INSERT INTO announcement (id,"schoolId",title,body,"createdById","updatedAt") VALUES ($1,$2,'Hi','Body',$3,now())`,
      [announcementA, A, userA],
    );
    // Scholarship application (student userA in school A; programId is a scalar
    // uuid to the global program — no DB FK — so it purges any time before school).
    await a.query(
      `INSERT INTO scholarship_application (id,"schoolId","programId","studentId","applicantId","applicantRole",status,"updatedAt")
       VALUES ($1,$2,$3,$4,$5,'parent','SUBMITTED',now())`,
      [scholarshipApplicationA, A, randomUUID(), userA, userA],
    );
    // Hostel + room + allocation (student userA in school A).
    await a.query(
      `INSERT INTO hostel (id,"schoolId",name,type,"updatedAt") VALUES ($1,$2,'Hostel A','MIXED',now())`,
      [hostelA, A],
    );
    await a.query(
      `INSERT INTO hostel_room (id,"schoolId","hostelId","roomNumber",capacity,"rentMinor","updatedAt") VALUES ($1,$2,$3,'R1',2,50000,now())`,
      [hostelRoomA, A, hostelA],
    );
    await a.query(
      `INSERT INTO hostel_allocation (id,"schoolId","roomId","studentId") VALUES ($1,$2,$3,$4)`,
      [hostelAllocationA, A, hostelRoomA, userA],
    );
    // Transport: vehicle + route + stop + assignment (student userA).
    await a.query(
      `INSERT INTO vehicle (id,"schoolId",name,capacity,"updatedAt") VALUES ($1,$2,'Bus 1',40,now())`,
      [vehicleA, A],
    );
    await a.query(
      `INSERT INTO transport_route (id,"schoolId",name,"vehicleId","fareMode","flatFareMinor","updatedAt") VALUES ($1,$2,'Route 1',$3,'FLAT',30000,now())`,
      [transportRouteA, A, vehicleA],
    );
    await a.query(
      `INSERT INTO route_stop (id,"schoolId","routeId",name,sequence,"fareMinor","updatedAt") VALUES ($1,$2,$3,'Stop 1',1,30000,now())`,
      [routeStopA, A, transportRouteA],
    );
    await a.query(
      `INSERT INTO transport_assignment (id,"schoolId","routeId","stopId","passengerId","passengerType","updatedAt") VALUES ($1,$2,$3,$4,$5,'STUDENT',now())`,
      [transportAssignmentA, A, transportRouteA, routeStopA, userA],
    );
    // Library: book + loan (borrower userA).
    await a.query(
      `INSERT INTO library_book (id,"schoolId",title,barcode,"totalCopies","availableCopies","updatedAt") VALUES ($1,$2,'Book A','BC-A',3,2,now())`,
      [libraryBookA, A],
    );
    await a.query(
      `INSERT INTO book_loan (id,"schoolId","bookId","borrowerId","dueAt","updatedAt") VALUES ($1,$2,$3,$4,now() + interval '14 days',now())`,
      [bookLoanA, A, libraryBookA, userA],
    );
    // Task: task + assignment + comment (creator + assignee userA).
    await a.query(
      `INSERT INTO task (id,"schoolId",title,"createdById","updatedAt") VALUES ($1,$2,'Task A',$3,now())`,
      [taskA, A, userA],
    );
    await a.query(
      `INSERT INTO task_assignment (id,"schoolId","taskId","assigneeId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [taskAssignmentA, A, taskA, userA],
    );
    await a.query(
      `INSERT INTO task_comment (id,"schoolId","taskId","authorId",body) VALUES ($1,$2,$3,$4,'Hi')`,
      [taskCommentA, A, taskA, userA],
    );
    // Poll: poll + option + vote (voter userA).
    await a.query(
      `INSERT INTO poll (id,"schoolId",question,"createdById","updatedAt") VALUES ($1,$2,'Q?',$3,now())`,
      [pollA, A, userA],
    );
    await a.query(
      `INSERT INTO poll_option (id,"schoolId","pollId",label) VALUES ($1,$2,$3,'Yes')`,
      [pollOptionA, A, pollA],
    );
    await a.query(
      `INSERT INTO poll_vote (id,"schoolId","pollId","optionId","voterId") VALUES ($1,$2,$3,$4,$5)`,
      [pollVoteA, A, pollA, pollOptionA, userA],
    );
    // Discussion: group + post + comment (author userA).
    await a.query(
      `INSERT INTO discussion_group (id,"schoolId",name,"createdById","updatedAt") VALUES ($1,$2,'G',$3,now())`,
      [discussionGroupA, A, userA],
    );
    await a.query(
      `INSERT INTO discussion_post (id,"schoolId","groupId","authorId",body,"updatedAt") VALUES ($1,$2,$3,$4,'P',now())`,
      [discussionPostA, A, discussionGroupA, userA],
    );
    await a.query(
      `INSERT INTO discussion_comment (id,"schoolId","postId","authorId",body) VALUES ($1,$2,$3,$4,'C')`,
      [discussionCommentA, A, discussionPostA, userA],
    );
    // Discipline: complaint + assignee + evidence + entry (complainant/against userA).
    await a.query(
      `INSERT INTO discipline_complaint (id,"schoolId",subject,"complainantId","againstId","updatedAt") VALUES ($1,$2,'S',$3,$4,now())`,
      [disciplineComplaintA, A, userA, userA],
    );
    await a.query(
      `INSERT INTO discipline_assignee (id,"schoolId","complaintId","assigneeId") VALUES ($1,$2,$3,$4)`,
      [disciplineAssigneeA, A, disciplineComplaintA, userA],
    );
    await a.query(
      `INSERT INTO discipline_evidence (id,"schoolId","complaintId","uploadedById","fileKey","fileName") VALUES ($1,$2,$3,$4,'k','f.png')`,
      [disciplineEvidenceA, A, disciplineComplaintA, userA],
    );
    await a.query(
      `INSERT INTO discipline_entry (id,"schoolId","complaintId","authorId",body) VALUES ($1,$2,$3,$4,'note')`,
      [disciplineEntryA, A, disciplineComplaintA, userA],
    );
    // Certificate: issued ID card (subject + issuer userA).
    await a.query(
      `INSERT INTO issued_certificate (id,"schoolId",type,"subjectId","issuedById",serial) VALUES ($1,$2,'ID_CARD',$3,$4,'ID-X')`,
      [issuedCertificateA, A, userA, userA],
    );
    // Alumni + Form (creator + respondent userA).
    await a.query(
      `INSERT INTO alumnus (id,"schoolId",name,"createdById","updatedAt") VALUES ($1,$2,'Old Boy',$3,now())`,
      [alumnusA, A, userA],
    );
    await a.query(
      `INSERT INTO form (id,"schoolId",title,"createdById","updatedAt") VALUES ($1,$2,'Survey',$3,now())`,
      [formA, A, userA],
    );
    await a.query(
      `INSERT INTO form_response (id,"schoolId","formId","respondentId") VALUES ($1,$2,$3,$4)`,
      [formResponseA, A, formA, userA],
    );
    await a.query(
      `INSERT INTO enrollment (id,"schoolId","classId","studentId") VALUES ($1,$2,$3,$4)`,
      [enrollmentA, A, classA, userA],
    );
    await a.query(
      `INSERT INTO parent_child (id,"schoolId","parentId","studentId") VALUES ($1,$2,$3,$4)`,
      [parentChildA, A, userA, userA],
    );
    // RBAC assignment: a global role row + a tenant-scoped user_role link.
    await a.query(`INSERT INTO role (id,name) VALUES ($1,$2)`, [roleX, `role-${roleX}`]);
    await a.query(
      `INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES ($1,$2,$3,$4)`,
      [userRoleA, A, userA, roleX],
    );
    // Integrity: consent + a retention-run record + a student exemption + draft/telemetry.
    await a.query(
      `INSERT INTO integrity_consent (id,"schoolId","studentId","grantedById") VALUES ($1,$2,$3,$3)`,
      [integrityConsentA, A, userA],
    );
    await a.query(
      `INSERT INTO integrity_retention_run (id,"schoolId","retentionDays",cutoff,"signalsDeleted","draftsDeleted","telemetryDeleted",trigger,"startedAt")
       VALUES ($1,$2,30,now(),0,0,0,'MANUAL',now())`,
      [retentionRunA, A],
    );
    await a.query(
      `INSERT INTO student_integrity_exemption (id,"schoolId","studentId",reason,"grantedById") VALUES ($1,$2,$3,'accommodation',$3)`,
      [exemptionA, A, userA],
    );
    await a.query(
      `INSERT INTO submission_draft (id,"schoolId","submissionId",sequence,"contentHash") VALUES ($1,$2,$3,1,'h')`,
      [draftA, A, submissionA],
    );
    await a.query(
      `INSERT INTO submission_telemetry (id,"schoolId","submissionId",kind,payload) VALUES ($1,$2,$3,'PASTE','{}'::jsonb)`,
      [telemetryA, A, submissionA],
    );
    // Messaging: a message + a participant on threadA.
    await a.query(
      `INSERT INTO message (id,"schoolId","threadId","senderId",body) VALUES ($1,$2,$3,$4,'hi')`,
      [messageA, A, threadA, userA],
    );
    await a.query(
      `INSERT INTO thread_participant (id,"schoolId","threadId","userId") VALUES ($1,$2,$3,$4)`,
      [threadParticipantA, A, threadA, userA],
    );
    // Platform subscription (one row per school) + a public admissions application.
    await a.query(
      `INSERT INTO school_subscription (id,"schoolId","updatedAt") VALUES ($1,$2,now())`,
      [schoolSubA, A],
    );
    await a.query(
      `INSERT INTO admission_application (id,"schoolId","applicantName","applicantEmail","childName","updatedAt") VALUES ($1,$2,'Parent','p@t','Kid',now())`,
      [admissionA, A],
    );
    // HR leave / salary / payroll (employeeA seeded above is the salary target).
    await a.query(
      `INSERT INTO leave_type (id,"schoolId",name,"daysPerYear","updatedAt") VALUES ($1,$2,'Annual',20,now())`,
      [leaveTypeA, A],
    );
    await a.query(
      `INSERT INTO leave_balance (id,"schoolId","userId","leaveTypeId",year,"updatedAt") VALUES ($1,$2,$3,$4,2026,now())`,
      [leaveBalanceA, A, userA, leaveTypeA],
    );
    await a.query(
      `INSERT INTO leave_request (id,"schoolId","userId","leaveTypeId","startDate","endDate",days,"updatedAt") VALUES ($1,$2,$3,$4,current_date,current_date,1,now())`,
      [leaveReqA, A, userA, leaveTypeA],
    );
    await a.query(
      `INSERT INTO salary_change_request (id,"schoolId","employeeId","requestedById","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [salaryChangeA, A, employeeA, userA],
    );
    await a.query(
      `INSERT INTO payroll_run (id,"schoolId","periodYear","periodMonth","runById","updatedAt") VALUES ($1,$2,2026,1,$3,now())`,
      [payrollRunA, A, userA],
    );
    await a.query(
      `INSERT INTO payslip (id,"schoolId","payrollRunId","userId") VALUES ($1,$2,$3,$4)`,
      [payslipA, A, payrollRunA, userA],
    );
    // HR staff lifecycle: a checklist (+ item), a document, a training record.
    await a.query(
      `INSERT INTO staff_checklist (id,"schoolId","userId",type,"createdById","updatedAt") VALUES ($1,$2,$3,'ONBOARDING',$3,now())`,
      [staffChecklistA, A, userA],
    );
    await a.query(
      `INSERT INTO staff_checklist_item (id,"schoolId","checklistId",label) VALUES ($1,$2,$3,'Sign contract')`,
      [staffChecklistItemA, A, staffChecklistA],
    );
    await a.query(
      `INSERT INTO staff_document (id,"schoolId","userId",kind,name,"createdById","updatedAt") VALUES ($1,$2,$3,'CONTRACT','Contract',$3,now())`,
      [staffDocumentA, A, userA],
    );
    await a.query(
      `INSERT INTO training_record (id,"schoolId","userId",title,"createdById","updatedAt") VALUES ($1,$2,$3,'First Aid',$3,now())`,
      [trainingRecordA, A, userA],
    );
    // HR appraisal + disciplinary case (+ entry).
    await a.query(
      `INSERT INTO appraisal (id,"schoolId","userId","reviewerId",period,"createdById","updatedAt") VALUES ($1,$2,$3,$3,'2026-H1',$3,now())`,
      [appraisalA, A, userA],
    );
    await a.query(
      `INSERT INTO disciplinary_case (id,"schoolId","userId",title,"openedById","updatedAt") VALUES ($1,$2,$3,'Lateness',$3,now())`,
      [disciplinaryCaseA, A, userA],
    );
    await a.query(
      `INSERT INTO disciplinary_entry (id,"schoolId","caseId",note,"authorId") VALUES ($1,$2,$3,'Initial note',$4)`,
      [disciplinaryEntryA, A, disciplinaryCaseA, userA],
    );
    // HR recruitment: a requisition + an applicant.
    await a.query(
      `INSERT INTO job_requisition (id,"schoolId",title,"createdById","updatedAt") VALUES ($1,$2,'Teacher',$3,now())`,
      [jobReqA, A, userA],
    );
    await a.query(
      `INSERT INTO applicant (id,"schoolId","requisitionId",name,email,"createdById","updatedAt") VALUES ($1,$2,$3,'Jane','jane@x',$4,now())`,
      [applicantA, A, jobReqA, userA],
    );
    await a.query(
      `INSERT INTO school_branding (id,"schoolId","updatedAt") VALUES ($1,$2,now())`,
      [schoolBrandingA, A],
    );
  });

  afterAll(async () => {
    const a = adminPool;
    for (const t of [
      "audit_log",
      "school_branding",
      // Hostel — allocation before room before hostel (FK order).
      "hostel_allocation",
      "hostel_room",
      "hostel",
      // Transport — assignment before stop/route, stop before route, route before vehicle.
      "transport_assignment",
      "route_stop",
      "transport_route",
      "vehicle",
      // Library — loan before book.
      "book_loan",
      "library_book",
      // Task — comment + assignment before task.
      "task_comment",
      "task_assignment",
      "task",
      // Poll — vote + option before poll.
      "poll_vote",
      "poll_option",
      "poll",
      // Discussion — comment + post before group.
      "discussion_comment",
      "discussion_post",
      "discussion_group",
      // Discipline — children before complaint.
      "discipline_entry",
      "discipline_evidence",
      "discipline_assignee",
      "discipline_complaint",
      // Certificate — append-only log (cleaned via admin pool).
      "issued_certificate",
      // Alumni + Form — response before form.
      "alumnus",
      "form_response",
      "form",
      // HR recruitment — applicant before requisition.
      "applicant",
      "job_requisition",
      // HR appraisals / disciplinary — entry before case.
      "disciplinary_entry",
      "disciplinary_case",
      "appraisal",
      // HR staff lifecycle — items before checklist.
      "staff_checklist_item",
      "staff_checklist",
      "staff_document",
      "training_record",
      // HR leave / salary / payroll — children first (payslip before payroll_run).
      "payslip",
      "payroll_run",
      "salary_change_request",
      "leave_request",
      "leave_balance",
      "leave_type",
      // Newly-covered tenant tables — child rows; safe to purge first (none are
      // parents of the tables listed below).
      "employee",
      // SIS import batch + announcement: FK to school only (scalar author) — leaves.
      "student_import_batch",
      "parent_import_batch",
      "announcement",
      // promotion_batch references class (source/target) AND term -> purge before
      // both; term references academic_session -> term before session.
      "promotion_batch",
      "term",
      "academic_session",
      // class_subject_teacher references class + subject + user -> purge first;
      // subject is its parent (and FK-free of class), so it follows.
      "class_subject_teacher",
      "subject",
      "class_teacher",
      "enrollment",
      "parent_child",
      "user_role",
      "integrity_consent",
      "integrity_retention_run",
      "student_integrity_exemption",
      "submission_draft",
      "submission_telemetry",
      "school_subscription",
      "admission_application",
      // Platform billing payment references school/user — delete before them.
      "platform_subscription_payment",
      // LMS content children (forum/quiz/progress) before lms_content; lms_content before class/user.
      "forum_post",
      "quiz_attempt",
      "lms_progress",
      "lms_submission",
      "lms_module",
      "lms_content_revision",
      "lms_live_attendance",
      "lms_live_session",
      "lms_award",
      "xapi_statement",
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
      // subject_result / subject_selection: only real FK is schoolId -> school
      // (session/term/class/subject/student are scalar uuids), so they purge
      // any time before school.
      "subject_result",
      "subject_selection",
      "scholarship_application",
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
    // Global (RLS-exempt) role row created for the user_role case — delete by id.
    await a.query(`DELETE FROM role WHERE id = $1`, [roleX]);
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
    ["subject_result", subjectResultA],
    ["subject_selection", subjectSelectionA],
    ["scholarship_application", scholarshipApplicationA],
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
    ["lms_progress", lmsProgressA],
    ["lms_submission", lmsSubmissionA],
    ["lms_module", lmsModuleA],
    ["lms_content_revision", lmsContentRevisionA],
    ["lms_live_session", liveSessionA],
    ["lms_live_attendance", liveAttendanceA],
    ["lms_award", lmsAwardA],
    ["xapi_statement", xapiStatementA],
    ["platform_subscription_payment", subPaymentA],
    ["employee", employeeA],
    ["class_teacher", classTeacherA],
    ["enrollment", enrollmentA],
    ["parent_child", parentChildA],
    ["user_role", userRoleA],
    ["integrity_consent", integrityConsentA],
    ["integrity_retention_run", retentionRunA],
    ["student_integrity_exemption", exemptionA],
    ["submission_draft", draftA],
    ["submission_telemetry", telemetryA],
    ["message", messageA],
    ["thread_participant", threadParticipantA],
    ["school_subscription", schoolSubA],
    ["admission_application", admissionA],
    ["ultimate_consent", ultimateConsentA],
    ["ultimate_enrollment", ultimateEnrollA],
    ["ultimate_entry_link", ultimateLinkA],
    ["leave_type", leaveTypeA],
    ["leave_balance", leaveBalanceA],
    ["leave_request", leaveReqA],
    ["salary_change_request", salaryChangeA],
    ["payroll_run", payrollRunA],
    ["payslip", payslipA],
    ["staff_checklist", staffChecklistA],
    ["staff_checklist_item", staffChecklistItemA],
    ["staff_document", staffDocumentA],
    ["training_record", trainingRecordA],
    ["appraisal", appraisalA],
    ["disciplinary_case", disciplinaryCaseA],
    ["disciplinary_entry", disciplinaryEntryA],
    ["job_requisition", jobReqA],
    ["applicant", applicantA],
    ["school_branding", schoolBrandingA],
    ["hostel", hostelA],
    ["hostel_room", hostelRoomA],
    ["hostel_allocation", hostelAllocationA],
    ["vehicle", vehicleA],
    ["transport_route", transportRouteA],
    ["route_stop", routeStopA],
    ["transport_assignment", transportAssignmentA],
    ["library_book", libraryBookA],
    ["book_loan", bookLoanA],
    ["task", taskA],
    ["task_assignment", taskAssignmentA],
    ["task_comment", taskCommentA],
    ["poll", pollA],
    ["poll_option", pollOptionA],
    ["poll_vote", pollVoteA],
    ["discussion_group", discussionGroupA],
    ["discussion_post", discussionPostA],
    ["discussion_comment", discussionCommentA],
    ["discipline_complaint", disciplineComplaintA],
    ["discipline_assignee", disciplineAssigneeA],
    ["discipline_evidence", disciplineEvidenceA],
    ["discipline_entry", disciplineEntryA],
    ["issued_certificate", issuedCertificateA],
    ["alumnus", alumnusA],
    ["form", formA],
    ["form_response", formResponseA],
    ["subject", subjectA],
    ["class_subject_teacher", classSubjectA],
    ["student_import_batch", importBatchA],
    ["parent_import_batch", parentImportBatchA],
    ["promotion_batch", promotionBatchA],
    ["academic_session", sessionA],
    ["term", termA],
    ["announcement", announcementA],
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

  // ---------------------------------------------------------------------------
  // Coverage gate: prove the suite ITSELF stays exhaustive. Any table that is
  // tenant-scoped (has a `schoolId` column) AND has row-level security enabled
  // MUST be proven isolated — either by a SELECT-deny case above or an
  // append-only INSERT/UPDATE test. A NEW tenant table fails this test until it
  // gets a deny case, so the "every RLS policy gets a cross-tenant test" rule
  // (CLAUDE.md) can no longer be silently skipped.
  // ---------------------------------------------------------------------------
  it("every RLS-enabled tenant table has a cross-tenant deny case (coverage gate)", async () => {
    const covered = new Set<string>([
      ...cases.map(([t]) => t),
      "audit_log", // append-only test below
      "integrity_signal", // append-only test below
      "workflow_audit_log", // append-only test below
    ]);
    // Documented RLS-EXEMPT: cross-tenant BY DESIGN (carries no PII). It has a
    // schoolId for grouping but intentionally no RLS (see 21_ultimate_rls.sql),
    // so it won't appear in the query below — listed here for the record.
    const exempt = new Set<string>(["ultimate_participant"]);
    const { rows } = await adminPool.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public' AND col.table_name = c.relname
            AND col.column_name = 'schoolId')
      ORDER BY 1`);
    const uncovered = rows
      .map((r) => r.relname)
      .filter((t) => !covered.has(t) && !exempt.has(t));
    expect(uncovered).toEqual([]);
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
