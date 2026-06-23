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
  "event.read",
  "event.write",
  // HR
  "hr.read",
  "hr.write",
  // Admin / RBAC
  "rbac.manage",
  // Platform operator
  "platform.operate",
  // Admissions
  "admission.review",
  // Dead & Wounded game (step 3 wires play + leaderboard; rest finalized in @sms/types)
  "game.play",
  "game.leaderboard.read",
  // LMS
  "class.read",
  "class.write",
  "enrollment.read",
  "enrollment.write",
  "guardian.write",
  // Gradebook
  "grade.read",
  "grade.write",
  // Approval workflow
  "workflow.create",
  "workflow.read",
  "workflow.review",
  "workflow.veto",
];

// Role -> permission matrix (CLAUDE.md RBAC + spec section 2).
const ROLE_PERMS: Record<string, string[]> = {
  // Platform owner: cross-tenant operator console + audited impersonation.
  super_admin: ["platform.operate", "security.audit.read"],
  // Board: read-only oversight + ultimate veto on workflows.
  board: ["class.read", "grade.read", "integrity.report.read", "workflow.read", "workflow.veto", "notification.read", "fee.read", "document.read", "timetable.read", "message.read", "message.send", "event.read",
  ],
  // Principal: full operational view of their school (can grade, review workflows).
  principal: [
    "assessment.read", "assessment.write", "submission.read",
    "integrity.report.read", "integrity.exemption.read", "integrity.exemption.write",
    "integrity.retention.run",
    "student.profile.read", "student.profile.write", "student.contact.read",
    "student.contact.write", "student.medical.read", "student.medical.write",
    "attendance.read", "attendance.write",
    "class.read", "class.write", "enrollment.read", "enrollment.write", "guardian.write",
    "grade.read", "grade.write",
    "workflow.create", "workflow.read", "workflow.review",
    "notification.read", "notification.send",
    "fee.read", "fee.manage", "fee.approve",
    "document.read", "document.write",
    "timetable.read", "timetable.write",
    "security.audit.read", "security.elevation.request", "security.elevation.approve",
    "privacy.erasure.review", "message.read", "message.send", "event.read", "event.write",
    "hr.read", "hr.write", "rbac.manage", "admission.review",
  ],
  // School Administrator: SIS / enrollment / workflows — but NOT grade books, NOT veto.
  school_admin: [
    "class.read", "class.write", "enrollment.read", "enrollment.write", "guardian.write",
    "assessment.read", "integrity.report.read", "integrity.exemption.read", "integrity.exemption.write",
    "integrity.retention.run",
    "student.profile.read", "student.profile.write", "student.contact.read",
    "student.contact.write", "student.medical.read", "student.medical.write",
    "attendance.read", "attendance.write",
    "workflow.create", "workflow.read", "workflow.review",
    "notification.read", "notification.send",
    "fee.read", "fee.manage", "fee.approve",
    "document.read", "document.write",
    "timetable.read", "timetable.write",
    "security.audit.read", "security.elevation.request", "security.elevation.approve",
    "privacy.erasure.review", "message.read", "message.send", "event.read", "event.write",
    "hr.read", "hr.write", "rbac.manage", "admission.review",
  ],
  teacher: [
    "assessment.read", "assessment.write", "submission.read",
    "integrity.report.read", "integrity.exemption.read", "integrity.exemption.write",
    "student.profile.read", "student.contact.read",
    "attendance.read", "attendance.write",
    "class.read", "enrollment.read", "grade.read", "grade.write",
    "workflow.create", "workflow.read",
    "notification.read", "notification.send",
    "document.read", "document.write",
    "timetable.read",
    "security.elevation.request", "message.read", "message.send", "event.read", "event.write",
    "game.play", "game.leaderboard.read",
  ],
  student: [
    "assessment.read", "submission.read", "submission.write",
    "integrity.signal.create", "class.read", "grade.read",
    "student.profile.read", "attendance.read",
    "notification.read", "fee.read", "document.read",
    "timetable.read", "message.read", "message.send", "event.read",
    "game.play", "game.leaderboard.read",
  ],
  parent: [
    "class.read", "grade.read",
    "student.profile.read", "student.contact.read", "student.medical.read",
    "attendance.read",
    "notification.read", "fee.read", "document.read",
    "timetable.read", "message.read", "message.send", "event.read",
  ],
  // Non-teaching staff: narrow. Both can raise workflow requests (POs / leave).
  // The accountant owns Fees/Billing.
  accountant: ["workflow.create", "workflow.read", "notification.read", "fee.read", "fee.manage", "document.read", "document.write", "security.elevation.request", "message.read", "message.send", "event.read",
  ],
  hr_clerk: ["workflow.create", "workflow.read", "notification.read", "security.elevation.request", "hr.read", "hr.write", "message.read", "message.send", "event.read",
  ],
};

async function main() {
  const school = await prisma.school.upsert({
    where: { slug: "demo" },
    update: {},
    create: { name: "St. Andrews Academy", slug: "demo" },
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
  const mkUser = (email: string, name: string) =>
    prisma.user.upsert({
      where: { email },
      update: {},
      create: { schoolId: school.id, email, name, passwordHash },
    });
  const admin = await mkUser("admin@demo.school", "Demo Admin");
  const principal = await mkUser("principal@demo.school", "Demo Principal");
  const board = await mkUser("board@demo.school", "Demo Board Member");
  const accountant = await mkUser("accountant@demo.school", "Demo Accountant");
  const hrClerk = await mkUser("hr@demo.school", "Demo HR Clerk");
  const owner = await mkUser("owner@sms.platform", "Platform Owner");

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
    [owner.id, await roleByName("super_admin")],
  ] as const) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId } },
      update: {},
      create: { schoolId: school.id, userId, roleId },
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

  console.log("Seeded:", { school: school.id, teacher: teacher.id, student: student.id });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
