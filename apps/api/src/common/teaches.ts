// =============================================================================
// "Which pupils do I teach?" — one answer, not three
// =============================================================================
// A class carries a teacher in TWO ways: `class.supervisorId` — the CLASS
// TEACHER, who is also the form teacher and the class supervisor, takes the
// register and answers for the class — and `class_subject_teacher`, whoever
// teaches one subject to that class. A THIRD, `class_teacher`, was a
// many-to-many join that shadowed the first and has been retired. Ten services
// asked which pupils a teacher may see, and they disagreed:
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
  const [supervises, subjects] = await Promise.all([
    tx.class.findMany({ where: { supervisorId: userId }, select: { id: true } }),
    tx.classSubjectTeacher.findMany({ where: { teacherId: userId }, select: { classId: true } }),
  ]);
  const ids = new Set<string>();
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

/** Does this user teach this ONE class, by any link? */
export async function teachesClass(tx: TenantTx, userId: string, classId: string): Promise<boolean> {
  return (await classIdsTaughtBy(tx, userId)).includes(classId);
}

/** Does this user teach ANY of these classes? */
export async function teachesAnyOf(tx: TenantTx, userId: string, classIds: string[]): Promise<boolean> {
  if (classIds.length === 0) return false;
  const mine = new Set(await classIdsTaughtBy(tx, userId));
  return classIds.some((id) => mine.has(id));
}

/**
 * The REVERSE lookup: every teacher of these classes.
 *
 * Used to route a complaint to the staff who know a pupil, and to answer "does
 * this class have anyone at all". The same links read the other way round — a
 * separate function because a set built by intersecting is not the set built by
 * collecting, and writing it inline is how the two drifted.
 */
export async function teacherIdsOfClasses(tx: TenantTx, classIds: string[]): Promise<string[]> {
  if (classIds.length === 0) return [];
  const [supervisors, subjects] = await Promise.all([
    tx.class.findMany({ where: { id: { in: classIds } }, select: { supervisorId: true } }),
    tx.classSubjectTeacher.findMany({ where: { classId: { in: classIds } }, select: { teacherId: true } }),
  ]);
  const ids = new Set<string>();
  for (const c of supervisors as Array<{ supervisorId: string | null }>) if (c.supervisorId) ids.add(c.supervisorId);
  for (const r of subjects as Array<{ teacherId: string }>) ids.add(r.teacherId);
  return [...ids];
}

/**
 * Does this user SUPERVISE this pupil — are they the CLASS TEACHER of a class
 * the pupil is actively enrolled in?
 *
 * THE NARROW QUESTION, and it is deliberately not the union above. Everything
 * else in this file answers "may I see this child", where the union is right:
 * you teach a pupil if you tutor, supervise or teach a subject to a class they
 * are in. A handful of acts are the CLASS TEACHER's alone — the remark on a
 * report card, the character ratings printed beside it — and those asked the
 * union, so any of a class's eleven subject teachers could perform them.
 *
 * Both of those write a SINGLE row keyed on (pupil, term): the remark is one
 * column, the ratings are one row per trait. So it was not merely a permission
 * a subject teacher should not have had — it was a silent overwrite of somebody
 * else's signed judgement about a child, with the card then attributing it to
 * whoever wrote last. Measured live: a class teacher's remark replaced by a
 * subject teacher's, re-signed with their name, no history and nothing to say
 * it had happened.
 *
 * ACTIVE enrolment only, like every other reader here.
 */
export async function supervisesStudent(tx: TenantTx, userId: string, studentId: string): Promise<boolean> {
  const enrolments = (await tx.enrollment.findMany({
    where: { studentId, status: "ACTIVE" },
    select: { classId: true },
  })) as Array<{ classId: string }>;
  if (enrolments.length === 0) return false;
  const supervised = (await tx.class.findMany({
    where: { id: { in: enrolments.map((e) => e.classId) }, supervisorId: userId },
    select: { id: true },
  })) as Array<{ id: string }>;
  return supervised.length > 0;
}

/**
 * The class teacher of the pupil's class, for WORDING a refusal — never for
 * deciding one.
 *
 * A class with no class teacher and a class whose class teacher is somebody
 * else need different sentences: one is "ask the office to assign one", the
 * other is "ask <name>". The register refusal already draws that distinction
 * and this is the same fork. Returns the pupil's class either way, so a caller
 * can name it.
 */
export async function supervisorOfStudent(
  tx: TenantTx,
  studentId: string,
): Promise<{ className: string; supervisorName: string | null } | null> {
  const enrolment = (await tx.enrollment.findFirst({
    where: { studentId, status: "ACTIVE" },
    select: { classId: true },
  })) as { classId: string } | null;
  if (!enrolment) return null;
  const cls = (await tx.class.findFirst({
    where: { id: enrolment.classId },
    select: { name: true, supervisorId: true },
  })) as { name: string; supervisorId: string | null } | null;
  if (!cls) return null;
  const supervisor = cls.supervisorId
    ? ((await tx.user.findFirst({ where: { id: cls.supervisorId }, select: { name: true } })) as { name: string } | null)
    : null;
  return { className: cls.name, supervisorName: supervisor?.name ?? null };
}

/**
 * The one refusal for "this is the class teacher's to write".
 *
 * Shared by the report-card remark and the character ratings because they are
 * the same rule, and two spellings of one rule is how the pair drifted in the
 * first place: both already SAID "only the pupil's class teacher or a school
 * administrator", in almost the same words, while both authorised the union.
 *
 * IT NAMES THE CLASS TEACHER ONLY TO SOMEBODY WHO ALREADY TEACHES THE PUPIL.
 * To anyone else the sentence stays generic, so the refusal cannot become a way
 * of asking who a pupil is or which class they are in.
 */
export async function classTeacherOnlyRefusal(
  tx: TenantTx,
  userId: string,
  studentId: string,
  act: string,
): Promise<string> {
  if (!(await teachesStudent(tx, userId, studentId))) {
    return `Only the pupil's class teacher or a school administrator may ${act}.`;
  }
  const cls = await supervisorOfStudent(tx, studentId);
  if (!cls) return `Only the pupil's class teacher or a school administrator may ${act}.`;
  return cls.supervisorName
    ? `${act.charAt(0).toUpperCase()}${act.slice(1)} is ${cls.className}'s class teacher's to write — ask ${cls.supervisorName}, or a school administrator.`
    : `${cls.className} has no class teacher yet, so nobody is responsible for this. Ask a school administrator to assign one.`;
}
