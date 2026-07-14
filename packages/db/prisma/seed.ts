// Dev/demo seed: a school, the RBAC permission/role graph, two users with
// bcrypt-hashed passwords, role assignments, NDPR integrity consent for the
// student, and one assessment. Run as a privileged role (RLS-bypassing) via
// `prisma db seed`. Idempotent.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const PERMS = [
  "assessment.read",
  "assessment.write",
  "submission.read",
  "submission.write",
  "integrity.signal.create",
  "integrity.report.read",
  "integrity.exemption.read",
  "integrity.exemption.write",
  "integrity.retention.run",
  // SIS
  "student.profile.read",
  "student.profile.write",
  "student.contact.read",
  "student.contact.write",
  "student.medical.read",
  "student.medical.write",
  // Attendance
  "attendance.read",
  "attendance.write",
  // Notifications
  "notification.read",
  "notification.send",
  // Fees / Billing
  "fee.read",
  "fee.manage",
  "fee.approve",
  // Hostel Management
  "hostel.read",
  "hostel.manage",
  // Transport Management
  "transport.read",
  "transport.manage",
  // Library Management
  "library.read",
  "library.borrow",
  "library.manage",
  // Task System
  "task.assign",
  "task.participate",
  // Polling System
  "poll.manage",
  "poll.vote",
  // Discussion Hub
  "discussion.participate",
  "discussion.moderate",
  // Discipline Room
  "discipline.file",
  "discipline.manage",
  // Certificate / ID generator
  "certificate.issue",
  // Alumni
  "alumni.manage",
  // Form builder
  "form.manage",
  "form.respond",
  // Document Vault
  "document.read",
  "document.write",
  // Timetabling
  "timetable.read",
  "timetable.write",
  // Security
  "security.audit.read",
  "security.elevation.request",
  "security.elevation.approve",
  // Privacy / NDPR
  "privacy.erasure.review",
  // Messaging + Calendar
  "message.read",
  "message.send",
  "event.read", "announcement.read",
  "event.write",
  // HR
  "hr.read",
  "hr.self",
  "hr.write",
  "hr.salary.request",
  "hr.salary.approve",
  "hr.leave.manage",
  "hr.payroll.run",
  "hr.appraisal.manage",
  "hr.disciplinary.manage",
  "hr.recruit.manage",
  "school.branding.manage",
  // Admin / RBAC
  "rbac.manage",
  "directory.search",
  // Announcements
  "announcement.manage",
  "announcement.read",
  // Platform operator
  "platform.operate",
  // Platform billing (self-serve subscription + dunning)
  "billing.read",
  "billing.manage",
  "billing.dunning.run",
  // Admissions
  "admission.review",
  // Dead & Wounded game (steps 3–8: play/leaderboard + league create + class race
  // open/tournament + match moderate + settings manage + the cross-school Ultimate
  // enroll/consent/admin) — the full finalized §8 permission set
  "game.play",
  "game.leaderboard.read",
  "game.quiz.host",
  "game.hangman.host",
  "game.typing.host",
  "game.league.create",
  "game.race.open",
  "game.race.tournament",
  "game.match.moderate",
  "game.settings.manage",
  "game.ultimate.enroll",
  "game.ultimate.consent",
  "game.ultimate.admin",
  // LMS
  "class.read",
  "class.write",
  "enrollment.read",
  "enrollment.write",
  "guardian.write",
  "subject.manage",
  "subject.select",
  "subject.selection.approve",
  "student.import",
  "family.read",
  "parent.import",
  "class.promote",
  "class.promote.approve",
  "academic.manage",
  // LMS learning content
  "lms.content.read",
  "lms.content.write",
  "lms.content.approve",
  "lms.quiz.attempt",
  "lms.forum.post",
  // Gradebook
  "grade.read",
  "grade.write",
  // Approval workflow
  "workflow.create",
  "workflow.read",
  "workflow.review",
  "workflow.veto",
  // Multi-stage staff-request chain (head -> HR -> principal)
  "workflow.review.head",
  "workflow.review.hr",
  "workflow.review.principal",
  // Scholarship (platform-sponsored)
  "scholarship.apply",
  "scholarship.read",
  "scholarship.admin",
];

// Role -> permission matrix (CLAUDE.md RBAC + spec section 2).
const ROLE_PERMS: Record<string, string[]> = {
  // Platform owner: cross-tenant operator console + audited impersonation.
  // super_admin is the cross-tenant operator; the ONLY game permission it holds
  // is the cross-school Ultimate admin (+ leaderboard read to view it).
  // notification.read: the operator's in-app inbox (new-onboarding-request
  // alerts). Self-scoped reads only — grants no reach into tenant data.
  super_admin: ["platform.operate", "billing.dunning.run", "security.audit.read", "directory.search", "game.ultimate.admin", "game.leaderboard.read", "scholarship.admin", "scholarship.read", "notification.read"],
  // Board: read-only oversight + ultimate veto on workflows.
  board: ["poll.vote", "discussion.participate", "discipline.file", "form.respond", "class.read", "grade.read", "integrity.report.read", "workflow.read", "workflow.veto", "notification.read", "fee.read", "document.read", "timetable.read", "message.read", "message.send", "event.read", "announcement.read", "billing.read", "scholarship.read",
  ],
  // Principal: full operational view of their school (can grade, review workflows).
  principal: [
    "assessment.read", "assessment.write", "submission.read",
    "integrity.report.read", "integrity.exemption.read", "integrity.exemption.write",
    "integrity.retention.run",
    "student.profile.read", "student.profile.write", "student.contact.read",
    "student.contact.write", "student.medical.read", "student.medical.write",
    "attendance.read", "attendance.write",
    "class.read", "class.write", "enrollment.read", "enrollment.write", "guardian.write", "subject.manage", "student.import", "parent.import", "class.promote", "academic.manage",
    "grade.read", "grade.write",
    "workflow.create", "workflow.read", "workflow.review", "workflow.review.principal",
    "notification.read", "notification.send",
    "fee.read", "fee.manage", "fee.approve",
    "hostel.read", "hostel.manage",
    "transport.read", "transport.manage",
    "library.read", "library.borrow", "library.manage",
    "task.assign", "task.participate",
    "poll.manage", "poll.vote",
    "discussion.participate", "discussion.moderate", "discipline.file", "discipline.manage", "certificate.issue", "alumni.manage", "form.manage", "form.respond",
    "document.read", "document.write",
    "timetable.read", "timetable.write",
    "security.audit.read", "security.elevation.request", "security.elevation.approve",
    "privacy.erasure.review", "message.read", "message.send", "event.read", "announcement.read", "event.write",
    "hr.read", "hr.self", "hr.write", "hr.salary.approve", "hr.payroll.run", "hr.appraisal.manage", "hr.disciplinary.manage", "hr.recruit.manage", "school.branding.manage", "rbac.manage", "admission.review", "directory.search", "announcement.manage", "announcement.read",
    "game.league.create", "game.leaderboard.read",
    "game.race.open", "game.race.tournament", "game.match.moderate", "game.quiz.host", "game.hangman.host", "game.typing.host",
    "game.ultimate.enroll",
    "lms.content.read", "lms.content.approve",
    "billing.read", "billing.manage",
    "scholarship.read",
  ],
  // School Administrator: SIS / enrollment / workflows — but NOT grade books, NOT veto.
  school_admin: [
    "class.read", "class.write", "enrollment.read", "enrollment.write", "guardian.write", "subject.manage", "subject.selection.approve", "student.import", "parent.import", "class.promote", "academic.manage",
    "assessment.read", "integrity.report.read", "integrity.exemption.read", "integrity.exemption.write",
    "integrity.retention.run",
    "grade.read", "grade.write",
    "student.profile.read", "student.profile.write", "student.contact.read",
    "student.contact.write", "student.medical.read", "student.medical.write",
    "attendance.read", "attendance.write",
    "workflow.create", "workflow.read", "workflow.review",
    "notification.read", "notification.send",
    "fee.read", "fee.manage", "fee.approve",
    "hostel.read", "hostel.manage",
    "transport.read", "transport.manage",
    "library.read", "library.borrow", "library.manage",
    "task.assign", "task.participate",
    "poll.manage", "poll.vote",
    "discussion.participate", "discussion.moderate", "discipline.file", "discipline.manage", "certificate.issue", "alumni.manage", "form.manage", "form.respond",
    "document.read", "document.write",
    "timetable.read", "timetable.write",
    "security.audit.read", "security.elevation.request", "security.elevation.approve",
    "privacy.erasure.review", "message.read", "message.send", "event.read", "announcement.read", "event.write",
    "hr.read", "hr.self", "hr.write", "hr.salary.approve", "hr.appraisal.manage", "hr.disciplinary.manage", "hr.recruit.manage", "school.branding.manage", "rbac.manage", "admission.review", "directory.search", "announcement.manage", "announcement.read",
    // School admin approves end-of-session promotions (maker-checker checker).
    "class.promote.approve",
    "game.league.create", "game.leaderboard.read",
    "game.race.open", "game.race.tournament", "game.match.moderate", "game.quiz.host", "game.hangman.host", "game.typing.host",
    "game.settings.manage",
    "game.ultimate.enroll", "game.ultimate.consent",
    "lms.content.read", "lms.content.write", "lms.forum.post",
    "billing.read", "billing.manage",
    "scholarship.read",
  ],
  teacher: ["hr.self", "task.assign", "task.participate", "poll.manage", "poll.vote",
    "discussion.participate", "discussion.moderate", "discipline.file", "discipline.manage", "certificate.issue", "alumni.manage", "form.manage", "form.respond",
    "assessment.read", "assessment.write", "submission.read",
    "integrity.report.read", "integrity.exemption.read", "integrity.exemption.write",
    "student.profile.read", "student.contact.read",
    "attendance.read", "attendance.write",
    "class.read", "enrollment.read", "grade.read", "grade.write",
    "workflow.create", "workflow.read",
    "notification.read", "notification.send",
    "document.read", "document.write",
    "timetable.read",
    "security.elevation.request", "message.read", "message.send", "event.read", "announcement.read", "event.write",
    "game.play", "game.leaderboard.read", "game.quiz.host", "game.hangman.host", "game.typing.host", "game.race.open", "game.match.moderate",
    "lms.content.read", "lms.content.write", "lms.forum.post",
    "scholarship.apply",
  ],
  student: [
    "assessment.read", "submission.read", "submission.write",
    "integrity.signal.create", "class.read", "grade.read", "subject.select",
    "student.profile.read", "attendance.read",
    "notification.read", "fee.read", "document.read",
    "timetable.read", "message.read", "message.send", "event.read", "announcement.read",
    "game.play", "game.leaderboard.read",
    "lms.content.read", "lms.quiz.attempt", "lms.forum.post",
    "library.read", "library.borrow",
    "task.participate", "poll.vote", "discussion.participate", "discipline.file", "form.respond",
  ],
  parent: [
    "poll.vote", "family.read",
    "class.read", "grade.read",
    "student.profile.read", "student.contact.read", "student.medical.read",
    "attendance.read",
    "notification.read", "fee.read", "document.read",
    "timetable.read", "message.read", "message.send", "event.read", "announcement.read",
    "lms.content.read",
    "scholarship.apply",
  ],
  // Non-teaching staff: narrow. Both can raise workflow requests (POs / leave).
  // The accountant owns Fees/Billing.
  accountant: ["hr.self", "poll.vote", "discussion.participate", "discipline.file", "form.respond", "workflow.create", "workflow.read", "notification.read", "fee.read", "fee.manage", "document.read", "document.write", "security.elevation.request", "message.read", "message.send", "event.read", "announcement.read", "billing.read",
  ],
  hr_clerk: ["hr.self", "poll.vote", "discussion.participate", "discipline.file", "form.respond", "workflow.create", "workflow.read", "notification.read", "security.elevation.request", "hr.read", "hr.write", "message.read", "message.send", "event.read", "announcement.read", "student.import", "parent.import", "class.read", "enrollment.read",
  ],
  // HR Manager: owns leave/salary/payroll + is the HR (stage-2) approver of the
  // staff-request chain. Salary maker-checker still needs TWO distinct managers.
  hr_manager: ["hr.self", "task.assign", "task.participate", "poll.vote", "discussion.participate", "discipline.file", "form.respond",
    "workflow.create", "workflow.read", "workflow.review", "workflow.review.hr",
    "hr.read", "hr.write", "hr.salary.request", "hr.salary.approve", "hr.leave.manage", "hr.payroll.run",
    "hr.appraisal.manage", "hr.disciplinary.manage", "hr.recruit.manage",
    // Coarse gate for the admissions review surface; the HR stage of the
    // maker-checker still requires the granular workflow.review.hr above.
    "admission.review", "student.import", "parent.import",
    // HR may view class lists + rosters (read-only) for onboarding/oversight.
    "class.read", "enrollment.read",
    "notification.read", "notification.send", "security.elevation.request",
    "message.read", "message.send", "event.read", "announcement.read",
  ],
  // Head of teaching: stage-1 approver for teaching staff requests.
  head_teacher: ["hr.self", "task.assign", "task.participate", "poll.vote", "discussion.participate", "discipline.file", "form.respond",
    "class.read", "enrollment.read", "attendance.read", "grade.read", "subject.selection.approve",
    "workflow.create", "workflow.read", "workflow.review", "workflow.review.head",
    "notification.read", "notification.send", "security.elevation.request",
    "message.read", "message.send", "event.read", "announcement.read",
  ],
  // Head of administration: stage-1 approver for non-teaching staff requests.
  head_admin: ["hr.self", "task.assign", "task.participate", "poll.vote", "discussion.participate", "discipline.file", "form.respond",
    "workflow.create", "workflow.read", "workflow.review", "workflow.review.head",
    "document.read", "notification.read", "notification.send", "security.elevation.request",
    "message.read", "message.send", "event.read", "announcement.read",
  ],
  // Hostel warden — manages ONLY the hostel(s) they are assigned to (scoped in the
  // service by Hostel.wardenId). Basic staff comms + self-service.
  warden: ["hr.self", "hostel.read", "hostel.manage", "notification.read",
    "message.read", "message.send", "event.read", "announcement.read", "task.participate",
  ],
  // Head warden — supervises EVERY hostel (module-wide scoping in HostelService);
  // fee runs they schedule are maker-checker (FEE_SCHEDULE workflow -> admin approves).
  head_warden: ["hr.self", "hostel.read", "hostel.manage", "workflow.create", "workflow.read",
    "notification.read", "message.read", "message.send", "event.read", "announcement.read", "task.participate",
  ],
  // Transport driver — reads ONLY their own vehicle / route / passengers (scoped in
  // the service by Vehicle.driverId). Read-only on transport; basic staff comms.
  driver: ["hr.self", "transport.read", "notification.read",
    "message.read", "message.send", "event.read", "announcement.read", "task.participate",
  ],
  // Head driver — manages the WHOLE fleet (vehicles/routes/assignments; module-wide
  // scoping in TransportService); fee runs are maker-checker like the head warden's.
  head_driver: ["hr.self", "transport.read", "transport.manage", "workflow.create", "workflow.read",
    "notification.read", "message.read", "message.send", "event.read", "announcement.read", "task.participate",
  ],
  // Librarian — owns the library module (catalogue, loans, fines, exports).
  librarian: ["hr.self", "library.read", "library.borrow", "library.manage", "workflow.create", "workflow.read",
    "notification.read", "message.read", "message.send", "event.read", "announcement.read", "task.participate",
  ],
};

async function main() {
  const school = await prisma.school.upsert({
    where: { slug: "demo" },
    update: {},
    create: { name: "St. Andrews Academy", slug: "demo" },
  });

  // Explicit subscription so the demo does NOT rely on the entitlement default
  // (which is now fail-closed to the entry tier) — the demo runs the full suite.
  // Idempotent: won't overwrite a plan already set for this school.
  await prisma.schoolSubscription.upsert({
    where: { schoolId: school.id },
    update: {},
    create: { schoolId: school.id, plan: "ENTERPRISE", status: "ACTIVE" },
  });

  // The platform-owner organization. NOT a customer tenant — it only hosts the
  // super_admin (the platform owner who sells the SMS to schools). Excluded from
  // the public directory, operator tenant list, directory search and billing. The
  // super_admin is therefore a member of NO customer school.
  const platformOrg = await prisma.school.upsert({
    where: { slug: "sms-platform" },
    update: { isPlatform: true, name: "MAESTRO-SMS" },
    create: { name: "MAESTRO-SMS", slug: "sms-platform", isPlatform: true },
  });

  for (const key of PERMS) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  for (const [roleName, keys] of Object.entries(ROLE_PERMS)) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName },
    });
    // Make the seed authoritative for role -> permissions (reconcile, not just add).
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    for (const key of keys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
  }

  const passwordHash = await bcrypt.hash("password123", 10);
  const teacher = await prisma.user.upsert({
    where: { email: "teacher@demo.school" },
    update: {},
    create: { schoolId: school.id, email: "teacher@demo.school", name: "Demo Teacher", passwordHash },
  });
  const student = await prisma.user.upsert({
    where: { email: "student@demo.school" },
    update: {},
    create: { schoolId: school.id, email: "student@demo.school", name: "Demo Student", passwordHash },
  });
  const parent = await prisma.user.upsert({
    where: { email: "parent@demo.school" },
    update: {},
    create: { schoolId: school.id, email: "parent@demo.school", name: "Demo Parent", passwordHash },
  });
  const mkUser = (email: string, name: string, schoolId: string = school.id) =>
    prisma.user.upsert({
      where: { email },
      update: {},
      create: { schoolId, email, name, passwordHash },
    });
  const admin = await mkUser("admin@demo.school", "Demo Admin");
  const principal = await mkUser("principal@demo.school", "Demo Principal");
  const board = await mkUser("board@demo.school", "Demo Board Member");
  const accountant = await mkUser("accountant@demo.school", "Demo Accountant");
  const hrClerk = await mkUser("hr@demo.school", "Demo HR Clerk");
  const hrManager = await mkUser("hrmanager@demo.school", "Demo HR Manager");
  const headTeacher = await mkUser("headteacher@demo.school", "Demo Head Teacher");
  const headAdmin = await mkUser("headadmin@demo.school", "Demo Head of Admin");
  const warden = await mkUser("warden@demo.school", "Demo Hostel Warden");
  const driver = await mkUser("driver@demo.school", "Demo Bus Driver");
  const headWarden = await mkUser("headwarden@demo.school", "Demo Head Warden");
  const headDriver = await mkUser("headdriver@demo.school", "Demo Head Driver");
  const librarian = await mkUser("librarian@demo.school", "Demo Librarian");
  // The platform owner lives in the platform org, NOT the demo customer school.
  const owner = await mkUser("owner@sms.platform", "Platform Owner", platformOrg.id);
  // SELF-HEAL: upsert never moves an existing user, so a DB seeded before the
  // platform-org model leaves the owner parked in the demo school (their console
  // then reads "St. Andrews Academy"). Relocate explicitly on every seed.
  await prisma.user.update({ where: { id: owner.id }, data: { schoolId: platformOrg.id } });

  const roleByName = async (name: string) =>
    (await prisma.role.findUniqueOrThrow({ where: { name } })).id;
  for (const [userId, roleId] of [
    [teacher.id, await roleByName("teacher")],
    [student.id, await roleByName("student")],
    [parent.id, await roleByName("parent")],
    [admin.id, await roleByName("school_admin")],
    [principal.id, await roleByName("principal")],
    [board.id, await roleByName("board")],
    [accountant.id, await roleByName("accountant")],
    [hrClerk.id, await roleByName("hr_clerk")],
    [hrManager.id, await roleByName("hr_manager")],
    [headTeacher.id, await roleByName("head_teacher")],
    [headAdmin.id, await roleByName("head_admin")],
    [warden.id, await roleByName("warden")],
    [driver.id, await roleByName("driver")],
    [headWarden.id, await roleByName("head_warden")],
    [headDriver.id, await roleByName("head_driver")],
    [librarian.id, await roleByName("librarian")],
    [owner.id, await roleByName("super_admin")],
  ] as const) {
    // The super_admin's role is scoped to the platform org, every other demo
    // user's to the demo school.
    const roleSchoolId = userId === owner.id ? platformOrg.id : school.id;
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId } },
      // Self-healing: corrects rows created before the platform-org model.
      update: { schoolId: roleSchoolId },
      create: { schoolId: roleSchoolId, userId, roleId },
    });
  }

  // --- HR: a couple of leave types so staff can apply immediately ---
  for (const [name, daysPerYear] of [["Annual", 20], ["Sick", 10]] as const) {
    await prisma.leaveType.upsert({
      where: { schoolId_name: { schoolId: school.id, name } },
      update: {},
      create: { schoolId: school.id, name, daysPerYear },
    });
  }

  // --- LMS: a class with the teacher assigned, the student enrolled, and the
  //     parent linked to the student (drives relationship scoping) ---
  const klass = await prisma.class.upsert({
    where: { id: "55555555-5555-5555-5555-555555555555" },
    update: {},
    create: {
      id: "55555555-5555-5555-5555-555555555555",
      schoolId: school.id,
      name: "History 101",
      subject: "History",
    },
  });
  await prisma.classTeacher.upsert({
    where: { classId_teacherId: { classId: klass.id, teacherId: teacher.id } },
    update: {},
    create: { schoolId: school.id, classId: klass.id, teacherId: teacher.id },
  });
  await prisma.enrollment.upsert({
    where: { classId_studentId: { classId: klass.id, studentId: student.id } },
    update: {},
    create: { schoolId: school.id, classId: klass.id, studentId: student.id },
  });
  await prisma.parentChild.upsert({
    where: { parentId_studentId: { parentId: parent.id, studentId: student.id } },
    update: {},
    create: { schoolId: school.id, parentId: parent.id, studentId: student.id, relationship: "parent" },
  });

  const consent = await prisma.integrityConsent.findFirst({
    where: { studentId: student.id, revokedAt: null },
  });
  if (!consent) {
    await prisma.integrityConsent.create({
      data: { schoolId: school.id, studentId: student.id, grantedById: teacher.id },
    });
  }

  await prisma.assessment.upsert({
    where: { id: "33333333-3333-3333-3333-333333333333" },
    update: {},
    create: {
      id: "33333333-3333-3333-3333-333333333333",
      schoolId: school.id,
      classId: klass.id,
      title: "Argumentative Essay — The Industrial Revolution",
      createdById: teacher.id,
      pasteBlocked: true,
      focusTracked: true,
      typingTracked: true,
      integrityEnabled: true,
    },
  });

  // --- Live Quiz starter content (one themed quiz per subject) ---------------
  // So a school can host a quiz out of the box without authoring first.
  // Idempotent: only seeds when the school has no quizzes yet.
  const STARTER_QUIZZES: Array<{
    title: string;
    theme: string;
    difficulty: string;
    questions: Array<{ prompt: string; choices: string[]; answerIndex: number }>;
  }> = [
    {
      title: "World Capitals",
      theme: "GEOGRAPHY",
      difficulty: "EASY",
      questions: [
        { prompt: "What is the capital of Kenya?", choices: ["Nairobi", "Lagos", "Cairo", "Accra"], answerIndex: 0 },
        { prompt: "What is the capital of Japan?", choices: ["Seoul", "Tokyo", "Beijing", "Bangkok"], answerIndex: 1 },
        { prompt: "On which continent is Egypt?", choices: ["Asia", "Europe", "Africa", "South America"], answerIndex: 2 },
        { prompt: "Which is the longest river in the world?", choices: ["Amazon", "Nile", "Yangtze", "Congo"], answerIndex: 1 },
      ],
    },
    {
      title: "Science Basics",
      theme: "SCIENCE",
      difficulty: "MEDIUM",
      questions: [
        { prompt: "What gas do plants absorb from the air?", choices: ["Oxygen", "Nitrogen", "Carbon dioxide", "Hydrogen"], answerIndex: 2 },
        { prompt: "What is the chemical symbol for water?", choices: ["WO", "H2O", "HO2", "O2"], answerIndex: 1 },
        { prompt: "Which planet is known as the Red Planet?", choices: ["Venus", "Jupiter", "Mars", "Saturn"], answerIndex: 2 },
        { prompt: "What force pulls objects toward the Earth?", choices: ["Magnetism", "Gravity", "Friction", "Tension"], answerIndex: 1 },
      ],
    },
    {
      title: "Art & Artists",
      theme: "ART",
      difficulty: "MEDIUM",
      questions: [
        { prompt: "Who painted the Mona Lisa?", choices: ["Van Gogh", "Picasso", "Leonardo da Vinci", "Monet"], answerIndex: 2 },
        { prompt: "Which colours mix to make green?", choices: ["Red + Blue", "Blue + Yellow", "Red + Yellow", "Black + White"], answerIndex: 1 },
        { prompt: "A sculpture is a work of art that is…", choices: ["Painted flat", "Three-dimensional", "A photograph", "A song"], answerIndex: 1 },
        { prompt: "Which movement is Salvador Dalí associated with?", choices: ["Surrealism", "Cubism", "Impressionism", "Baroque"], answerIndex: 0 },
      ],
    },
    {
      title: "Classic Literature",
      theme: "LITERATURE",
      difficulty: "HARD",
      questions: [
        { prompt: "Who wrote 'Romeo and Juliet'?", choices: ["Charles Dickens", "William Shakespeare", "Jane Austen", "Mark Twain"], answerIndex: 1 },
        { prompt: "'Things Fall Apart' was written by…", choices: ["Wole Soyinka", "Chinua Achebe", "Ngũgĩ wa Thiong'o", "Ben Okri"], answerIndex: 1 },
        { prompt: "What is a group of lines in a poem called?", choices: ["Chapter", "Stanza", "Verse chapter", "Paragraph"], answerIndex: 1 },
        { prompt: "Who is the author of 'Pride and Prejudice'?", choices: ["Emily Brontë", "Jane Austen", "Virginia Woolf", "George Eliot"], answerIndex: 1 },
      ],
    },
  ];
  const existingQuizzes = await prisma.liveQuiz.count({ where: { schoolId: school.id } });
  if (existingQuizzes === 0) {
    for (const q of STARTER_QUIZZES) {
      const quiz = await prisma.liveQuiz.create({
        data: { schoolId: school.id, title: q.title, theme: q.theme, difficulty: q.difficulty, createdById: teacher.id },
      });
      await prisma.liveQuizQuestion.createMany({
        data: q.questions.map((qq, i) => ({
          schoolId: school.id,
          quizId: quiz.id,
          orderIndex: i,
          prompt: qq.prompt,
          choices: qq.choices,
          answerIndex: qq.answerIndex,
        })),
      });
    }
  }

  console.log("Seeded:", { school: school.id, teacher: teacher.id, student: student.id });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
