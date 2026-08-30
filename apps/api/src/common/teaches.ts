// =============================================================================
// "Which pupils do I teach?" — one answer, not three
// =============================================================================
// A class carries a teacher in THREE ways: `class_teacher` (the form tutor),
// `class.supervisorId` (the class supervisor) and `class_subject_teacher` (the
// person who teaches a subject to that class). Ten services asked which pupils
// a teacher may see, and they disagreed:
//
//   class_teacher only                    /students, search, documents, SIS,
//                                         notification send
//   class_teacher + class_subject_teacher dashboard, messaging, meetings,
//                                         discipline, staff handover
//   supervisorId + class_subject_teacher  report-card remarks, trait ratings
//
// Measured live on the demo school: of 61 teachers, ONE is a form tutor and
// NINE teach only subjects — and structurally that is the normal shape of a
// secondary school, where most teachers take a subject across many classes and
// tutor none. A teacher with 30 subject offerings across 899 pupils got:
//
//   GET /classes/mine   200, their classes
//   GET /students       []            <- the platform knows they teach and
//   GET /search?q=…     no hits          will not tell them who
//
// while the SAME teacher could write those pupils' report-card remarks and
// character ratings, because that module used the third definition.
//
// So this is drift, not policy: no reading of the product makes someone a
// teacher for the purpose of grading a child and a stranger for the purpose of
// listing them. The union is what a school would say out loud — you teach a
// pupil if you tutor, supervise or teach a subject to a class they are in.
//
// ACTIVE enrolment only, everywhere. The rule "a teacher must not keep access
// to a pupil who has since withdrawn, transferred or been promoted out" was
// proven live once already and must survive this consolidation.
// =============================================================================

import type { TenantTx } from "../integrity/integrity.foundation";

/** Every class this user teaches, by any of the three links. */
export async function classIdsTaughtBy(tx: TenantTx, userId: string): Promise<string[]> {
  const [tutor, supervises, subjects] = await Promise.all([
    tx.classTeacher.findMany({ where: { teacherId: userId }, select: { classId: true } }),
    tx.class.findMany({ where: { supervisorId: userId }, select: { id: true } }),
    tx.classSubjectTeacher.findMany({ where: { teacherId: userId }, select: { classId: true } }),
  ]);
  const ids = new Set<string>();
  for (const r of tutor as Array<{ classId: string }>) ids.add(r.classId);
  for (const r of supervises as Array<{ id: string }>) ids.add(r.id);
  for (const r of subjects as Array<{ classId: string }>) ids.add(r.classId);
  return [...ids];
}

/** The pupils actively enrolled in any class this user teaches. */
export async function studentIdsTaughtBy(tx: TenantTx, userId: string): Promise<string[]> {
  const classIds = await classIdsTaughtBy(tx, userId);
  if (classIds.length === 0) return [];
  const enrolled = (await tx.enrollment.findMany({
    where: { classId: { in: classIds }, status: "ACTIVE" },
    select: { studentId: true },
    distinct: ["studentId"],
  })) as Array<{ studentId: string }>;
  return enrolled.map((e) => e.studentId);
}

/** Does this user teach this pupil, right now? */
export async function teachesStudent(tx: TenantTx, userId: string, studentId: string): Promise<boolean> {
  const enrolments = (await tx.enrollment.findMany({
    where: { studentId, status: "ACTIVE" },
    select: { classId: true },
  })) as Array<{ classId: string }>;
  if (enrolments.length === 0) return false;
  const classIds = new Set(enrolments.map((e) => e.classId));
  return (await classIdsTaughtBy(tx, userId)).some((id) => classIds.has(id));
}
