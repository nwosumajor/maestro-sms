import { Body, Controller, Delete, Get, Header, Param, Post, Put, Query } from "@nestjs/common";
import { MODULES, USER_KINDS, type UserKind , SUBJECT_STAGES, CLASS_STREAMS, CLASS_ARMS, WORKFLOW_PERMISSIONS } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { AcademicSessionDto, ClassDto, ClassEligibilityDto, ClassInfoDto, ClassOverviewDto, ClassSubjectDto, IdNameDto, PromotionBatchDto, SchoolHolidayDto, SubjectDto, UserWithEmailDto } from "@sms/types";
import { z } from "zod";
import { LMS_PERMISSIONS, SIS_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { LmsService } from "./lms.service";
import { SyllabusService } from "./syllabus.service";
import { PromotionService } from "./promotion.service";
import { AcademicService } from "./academic.service";
import { StudentExitService } from "./student-exit.service";

// stage / stream / arm are ENUMS, not free text: the web offers them as selects
// so nobody can create a fifth spelling of "Science" and split a year group in
// two. Zod rejects anything off the list rather than storing it.
const classShape = {
  level: z.number().int().min(0).max(50).nullish(),
  nextClassId: z.string().uuid().nullish(),
  stage: z.enum(SUBJECT_STAGES).nullish(),
  stream: z.enum(CLASS_STREAMS).nullish(),
  arm: z.enum(CLASS_ARMS).nullish(),
};
const createClassSchema = z.object({ name: z.string().min(1), ...classShape });
const updateClassSchema = z.object({
  name: z.string().min(1).optional(),
  supervisorId: z.string().uuid().nullish(),
  capacity: z.number().int().min(0).max(10000).nullish(),
  ...classShape,
});
const enrollStatusSchema = z.object({
  status: z.enum(["ACTIVE", "TRANSFERRED", "WITHDRAWN"]),
  reason: z.string().max(500).optional(),
});
const sessionSchema = z.object({
  name: z.string().min(1).max(60),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish();
/** Every field optional: an edit that only renames must not require the dates. */
const sessionUpdateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  startDate: isoDate,
  endDate: isoDate,
});
const termSchema = z.object({
  name: z.string().min(1).max(60),
  sequence: z.number().int().min(1).max(6),
  startDate: isoDate,
  endDate: isoDate,
});
// Term edit — all fields optional; a null date CLEARS it. endDate is what the
// automatic end-of-term progression sweep keys on.
const termUpdateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  sequence: z.number().int().min(1).max(6).optional(),
  startDate: isoDate,
  endDate: isoDate,
});
// Bounded so one request cannot try to add an unbounded list; the largest real
// curriculum here is 56 entries.
const syllabusSchema = z.object({
  classId: z.string().uuid(),
  subjectId: z.string().uuid(),
  termId: z.string().uuid(),
  overview: z.string().max(4000).nullish(),
  // Bounded here AND in the service: the boundary rejects nonsense, the service
  // owns the rule.
  items: z
    .array(
      z.object({
        week: z.number().int().min(1).max(60),
        topic: z.string().min(1).max(200),
        objectives: z.string().max(2000).nullish(),
        resources: z.string().max(2000).nullish(),
      }),
    )
    .max(60),
});
const syllabusStatusSchema = z.object({ status: z.enum(["PLANNED", "TAUGHT"]) });
const gradingPolicySchema = z.object({
  scale: z.string().max(24).optional(),
  // Floors only — there is nowhere to type a ceiling, which is what makes a gap
  // or an overlap unrepresentable rather than merely validated.
  bands: z.array(z.object({ min: z.number().int().min(0).max(100), grade: z.string().min(1).max(4) })).min(2).max(15).optional(),
  weights: z.record(z.string(), z.number().int().min(0).max(100)).optional(),
});
const catalogueAddSchema = z.object({ codes: z.array(z.string().min(1).max(16)).min(1).max(100) });
const standardSessionSchema = z.object({
  name: z.string().min(1).max(60),
  yearStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  makeCurrent: z.boolean().optional(),
  // Omitted => the school's own shape, which defaults to its country's.
  template: z.string().max(24).optional(),
});
const holidaySchema = z.object({
  name: z.string().min(1).max(100),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const teacherSchema = z.object({ teacherId: z.string().uuid() });
const studentSchema = z.object({ studentId: z.string().uuid() });
const guardianSchema = z.object({ parentId: z.string().uuid(), studentId: z.string().uuid() });
const subjectSchema = z.object({ name: z.string().min(1).max(120), code: z.string().max(30).nullish() });
const subjectUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  code: z.string().max(30).nullish(),
});
const classSubjectsBulkSchema = z.object({
  items: z
    .array(
      z.object({
        subjectId: z.string().uuid(),
        teacherId: z.string().uuid(),
        lessonsPerWeek: z.number().int().min(1).max(20).optional(),
        preferredRoomId: z.string().uuid().nullish(),
      }),
    )
    .min(1)
    .max(60),
});
const enrollBulkSchema = z.object({ studentIds: z.array(z.string().uuid()).min(1).max(500) });
const classSubjectSchema = z.object({
  subjectId: z.string().uuid(),
  teacherId: z.string().uuid(),
  /** CSP timetable inputs (optional — omitting leaves the stored values alone). */
  lessonsPerWeek: z.number().int().min(1).max(15).optional(),
  preferredRoomId: z.string().uuid().nullish(),
  /** Also move lessons already placed for the PREVIOUS teacher. Opt-in: a
   *  published timetable should not be rewritten by a roster edit. */
  moveScheduledLessons: z.boolean().optional(),
});
const promotionSchema = z.object({
  sourceClassId: z.string().uuid(),
  targetClassId: z.string().uuid().nullish(),
  studentIds: z.array(z.string().uuid()).max(2000).optional(),
  // Per-student overrides. Anyone not named here is PROMOTEd. A DEMOTE must
  // name the lower class; the service rejects one that doesn't.
  decisions: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        outcome: z.enum(["PROMOTE", "RETAIN", "DEMOTE"]),
        targetClassId: z.string().uuid().nullish(),
        note: z.string().max(500).nullish(),
      }),
    )
    .max(2000)
    .optional(),
});
const promoteRejectSchema = z.object({ note: z.string().max(1000).optional() });

const exitSchema = z.object({
  kind: z.enum(["WITHDRAWN", "TRANSFERRED", "GRADUATED"]),
  reason: z.string().max(500).optional(),
});
const readmitSchema = z.object({ reason: z.string().max(500).optional() });
const retentionSchema = z.object({ years: z.number().int().min(0).max(50) });
const docReleaseSchema = z.object({ released: z.boolean(), reason: z.string().max(500).optional() });

@RequireModule(MODULES.LMS)

@Controller()
export class LmsController {
  constructor(
    
    private readonly exits: StudentExitService,private readonly lms: LmsService,
    private readonly syllabus: SyllabusService,
    private readonly promotion: PromotionService,
    private readonly academic: AcademicService,
  ) {}

  @Post("classes")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  createClass(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createClassSchema)) body: z.infer<typeof createClassSchema>,
  ) {
    return this.lms.createClass(p, body);
  }

  /** Update class progression (level / next class) + supervisor + metadata. */
  @Put("classes/:classId")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  updateClass(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(updateClassSchema)) body: z.infer<typeof updateClassSchema>,
  ) {
    return this.lms.updateClass(p, classId, body);
  }

  /** Delete a class — only while it is EMPTY (e.g. a duplicate created in error). */
  @Delete("classes/:classId")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  deleteClass(@CurrentPrincipal() p: Principal, @Param("classId") classId: string) {
    return this.lms.deleteClass(p, classId);
  }

  // --- subject catalog + per-class offerings --------------------------------
  // --- subject syllabus (scheme of work) -------------------------------------
  /** The plan for one offering in one term. Null when none exists yet. */
  @Get("syllabus")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  getSyllabus(
    @CurrentPrincipal() p: Principal,
    @Query("classId") classId: string,
    @Query("subjectId") subjectId: string,
    @Query("termId") termId: string,
  ) {
    return this.syllabus.get(p, { classId, subjectId, termId });
  }

  /** Every plan the caller may see for a term — the review view. */
  @Get("syllabus/term/:termId")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  listSyllabi(@CurrentPrincipal() p: Principal, @Param("termId") termId: string) {
    return this.syllabus.listForTerm(p, termId);
  }

  /** Create or replace a term plan. Written by the teacher of that offering. */
  @Put("syllabus")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  upsertSyllabus(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(syllabusSchema)) body: z.infer<typeof syllabusSchema>,
  ) {
    return this.syllabus.upsert(
      p,
      { classId: body.classId, subjectId: body.subjectId, termId: body.termId },
      { overview: body.overview ?? null, items: body.items },
    );
  }

  /** Mark a week taught, or put it back to planned. */
  @Put("syllabus/items/:id/status")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  setSyllabusItemStatus(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(syllabusStatusSchema)) body: z.infer<typeof syllabusStatusSchema>,
  ) {
    return this.syllabus.setItemStatus(p, id, body.status);
  }

  /** Remove a plan and its weeks. */
  @Delete("syllabus/:id")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  deleteSyllabus(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.syllabus.remove(p, id);
  }

  /** The catalogue this school should be offered, with what it already has marked. */
  @Get("subjects/catalogue")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  subjectCatalogue(@CurrentPrincipal() p: Principal, @Query("stage") stage?: string) {
    return this.lms.subjectCatalogue(p, stage);
  }

  /** Copy picked catalogue entries into this school's own subjects. */
  @Post("subjects/from-catalogue")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  addSubjectsFromCatalogue(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(catalogueAddSchema)) body: z.infer<typeof catalogueAddSchema>,
  ) {
    return this.lms.addSubjectsFromCatalogue(p, body.codes);
  }

  @Post("subjects")
  @RequirePermission(LMS_PERMISSIONS.SUBJECT_MANAGE)
  createSubject(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(subjectSchema)) body: z.infer<typeof subjectSchema>,
  ): Promise<SubjectDto> {
    return this.lms.createSubject(p, body);
  }

  @Get("subjects")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  subjects(@CurrentPrincipal() p: Principal): Promise<SubjectDto[]> {
    return this.lms.listSubjects(p);
  }

  /** Rename / re-code a subject (fix a typo'd or duplicated catalog entry). */
  @Put("subjects/:subjectId")
  @RequirePermission(LMS_PERMISSIONS.SUBJECT_MANAGE)
  updateSubject(
    @CurrentPrincipal() p: Principal,
    @Param("subjectId") subjectId: string,
    @Body(new ZodValidationPipe(subjectUpdateSchema)) body: z.infer<typeof subjectUpdateSchema>,
  ): Promise<SubjectDto> {
    return this.lms.updateSubject(p, subjectId, body);
  }

  /** Delete an UNUSED subject (409 while any class still offers it). */
  @Delete("subjects/:subjectId")
  @RequirePermission(LMS_PERMISSIONS.SUBJECT_MANAGE)
  deleteSubject(@CurrentPrincipal() p: Principal, @Param("subjectId") subjectId: string) {
    return this.lms.deleteSubject(p, subjectId);
  }

  /** Assign MANY subjects to a class at once (all-or-nothing, upserts). */
  @Post("classes/:classId/subjects/bulk")
  @RequirePermission(LMS_PERMISSIONS.SUBJECT_MANAGE)
  assignClassSubjectsBulk(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(classSubjectsBulkSchema)) body: z.infer<typeof classSubjectsBulkSchema>,
  ) {
    return this.lms.assignClassSubjectsBulk(p, classId, body.items);
  }

  @Post("classes/:classId/subjects")
  @RequirePermission(LMS_PERMISSIONS.SUBJECT_MANAGE)
  assignClassSubject(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(classSubjectSchema)) body: z.infer<typeof classSubjectSchema>,
  ) {
    return this.lms.assignClassSubject(p, classId, body.subjectId, body.teacherId, {
      lessonsPerWeek: body.lessonsPerWeek,
      preferredRoomId: body.preferredRoomId,
      moveScheduledLessons: body.moveScheduledLessons,
    });
  }

  /** Remove a subject offering from a class (needed before a subject delete). */
  @Delete("classes/:classId/subjects/:subjectId")
  @RequirePermission(LMS_PERMISSIONS.SUBJECT_MANAGE)
  removeClassSubject(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Param("subjectId") subjectId: string,
  ) {
    return this.lms.removeClassSubject(p, classId, subjectId);
  }

  /** Copy this class's subject set onto every other arm of the same stream —
   *  one action instead of one configuration per arm. */
  @Post("classes/:classId/subjects/copy-to-arms")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  copySubjectsToArms(@CurrentPrincipal() p: Principal, @Param("classId") classId: string) {
    return this.lms.copySubjectsToArms(p, classId);
  }

  @Get("classes/:classId/subjects")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  classSubjects(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
  ): Promise<ClassSubjectDto[]> {
    return this.lms.listClassSubjects(p, classId);
  }

  @Post("classes/:classId/teachers")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_WRITE)
  assignTeacher(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(teacherSchema)) body: { teacherId: string },
  ) {
    return this.lms.assignTeacher(p, classId, body.teacherId);
  }

  /** Take a class teacher off a class — the counterpart the assign route never
   *  had, so class-wide access could be granted and never revoked. */
  @Delete("classes/:classId/teachers/:teacherId")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_WRITE)
  removeTeacher(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Param("teacherId") teacherId: string,
  ) {
    return this.lms.removeTeacher(p, classId, teacherId);
  }

  /** Enrol MANY students at once — one capacity check, already-enrolled skipped. */
  @Post("classes/:classId/enrollments/bulk")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_WRITE)
  enrollBulk(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(enrollBulkSchema)) body: z.infer<typeof enrollBulkSchema>,
  ) {
    return this.lms.enrollStudentsBulk(p, classId, body.studentIds);
  }

  @Post("classes/:classId/enrollments")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_WRITE)
  enroll(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(studentSchema)) body: { studentId: string },
  ) {
    return this.lms.enrollStudent(p, classId, body.studentId);
  }

  @Post("guardians")
  @RequirePermission(LMS_PERMISSIONS.GUARDIAN_WRITE)
  linkGuardian(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(guardianSchema)) body: { parentId: string; studentId: string },
  ) {
    return this.lms.linkGuardian(p, body.parentId, body.studentId);
  }

  /** Remove a guardian link. Same permission as creating one: a school that may
   *  attach an adult to a child's record must be able to detach them again. */
  @Delete("guardians/:parentId/:studentId")
  @RequirePermission(LMS_PERMISSIONS.GUARDIAN_WRITE)
  unlinkGuardian(
    @CurrentPrincipal() p: Principal,
    @Param("parentId", new ZodValidationPipe(z.string().uuid())) parentId: string,
    @Param("studentId", new ZodValidationPipe(z.string().uuid())) studentId: string,
  ) {
    return this.lms.unlinkGuardian(p, parentId, studentId);
  }

  /** Relationship-scoped: returns only classes the caller may see. */
  @Get("classes/mine")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  myClasses(@CurrentPrincipal() p: Principal): Promise<ClassDto[]> {
    return this.lms.listMyClasses(p);
  }

  /** Relationship-scoped student directory (id + name) for UI pickers.
   *  `?q=` narrows server-side and caps the result — for large-school typeahead. */
  @Get("students")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  students(@CurrentPrincipal() p: Principal, @Query("q") q?: string): Promise<IdNameDto[]> {
    return this.lms.listStudents(p, q);
  }

  /** How many students the caller can see. Exists so nothing has to COUNT the list
   *  above — which is why that list had to stay uncapped. */
  @Get("students/count")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  studentCount(@CurrentPrincipal() p: Principal): Promise<{ students: number }> {
    return this.lms.countStudents(p);
  }

  /** Staff user directory (id + name + roles) for admin pickers. class.write-gated.
   *  `?kind=staff|teacher|parent` narrows by role category so pickers never mix
   *  students into a staff list (omit for the full directory, e.g. role admin). */
  @Get("users")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  users(
    @CurrentPrincipal() p: Principal,
    @Query("kind", new ZodValidationPipe(z.enum(USER_KINDS).optional())) kind?: UserKind,
    @Query("q") q?: string,
  ): Promise<UserWithEmailDto[]> {
    return this.lms.listUsers(p, kind, q);
  }

  /** The caller's classes with roll / capacity / supervisor / teaching counts —
   *  what the classes page is actually managed by. Same relationship scoping as
   *  /classes/mine; all counts come from grouped queries, never one per class. */
  @Get("classes/overview")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  classOverview(@CurrentPrincipal() p: Principal): Promise<ClassOverviewDto[]> {
    return this.lms.listClassOverview(p);
  }

  @Get("classes/:classId")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_READ)
  roster(@CurrentPrincipal() p: Principal, @Param("classId") classId: string) {
    return this.lms.getClassRoster(p, classId);
  }

  /** Member-facing class info (subjects/teachers/supervisor) for parents/students. */
  @Get("classes/:classId/info")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  classInfo(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<ClassInfoDto> {
    return this.lms.getClassInfo(p, classId);
  }

  /** Promotion eligibility SIGNAL (avg score + attendance %) — staff only. */
  @Get("classes/:classId/eligibility")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_READ)
  eligibility(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<ClassEligibilityDto[]> {
    return this.lms.getClassEligibility(p, classId);
  }

  /** CSV export of a class roster (staff). */
  @Get("classes/:classId/roster.csv")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_READ)
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="class-roster.csv"')
  async rosterCsv(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<string> {
    const roster = await this.lms.getClassRoster(p, classId);
    const rows = (roster.students as Array<{ name: string; email: string }>).map(
      (s, i) => `${i + 1},"${s.name.replace(/"/g, '""')}",${s.email}`,
    );
    return `#,name,email\n${rows.join("\n")}\n`;
  }

  // --- student exit: leaving the SCHOOL (two-stage, principal finalises) -----
  /** What the approver should see first: classes, money owed, already-left. */
  @Get("students/:studentId/exit/preview")
  // READ, so gated on the student-record permission rather than the raise one:
  // the PRINCIPAL deliberately does not hold `student.exit.request` (it would
  // make them eligible for stage 1 and then bar them from stage 2), and the
  // approver of all people must be able to see what they are approving. The
  // service narrows the rows to whole-school staff.
  @RequirePermission(SIS_PERMISSIONS.STUDENT_PROFILE_READ)
  exitPreview(@CurrentPrincipal() p: Principal, @Param("studentId") studentId: string) {
    return this.exits.preview(p, studentId);
  }

  /**
   * RAISE a student exit. Stage 1 of two — the principal authorises it, and the
   * engine enforces that they are a different person. There is deliberately no
   * endpoint that applies an exit directly: the only path runs through the
   * workflow, so one person can never end a child's access.
   */
  @Post("students/:studentId/exit")
  @RequirePermission(WORKFLOW_PERMISSIONS.STUDENT_EXIT_REQUEST)
  requestExit(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(exitSchema)) body: z.infer<typeof exitSchema>,
  ) {
    return this.exits.request(p, studentId, body.kind, body.reason);
  }

  /** The leavers register. Paged — it only ever grows. */
  @Get("students/exited")
  // Same reasoning as the preview: a coarse read permission gates the route,
  // and the service narrows the rows to whole-school staff — a class teacher
  // holding student.profile.read must not get a school-wide leavers list.
  @RequirePermission(SIS_PERMISSIONS.STUDENT_PROFILE_READ)
  listExited(
    @CurrentPrincipal() p: Principal,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.exits.listExited(p, page ? Number(page) : 1, pageSize ? Number(pageSize) : 25);
  }

  /**
   * RE-ADMIT. Principal only, and a single step on purpose: the two-stage chain
   * exists to stop one person REMOVING access. Restoring it is the safe
   * direction, and needing a committee to undo a mistake is how mistakes stay.
   */
  @Post("students/:studentId/readmit")
  @RequirePermission(WORKFLOW_PERMISSIONS.STUDENT_EXIT_APPROVE)
  readmit(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(readmitSchema)) body: z.infer<typeof readmitSchema>,
  ) {
    return this.exits.readmit(p, studentId, body.reason);
  }

  /**
   * Release (or withhold) a leaver's academic documents.
   *
   * Principal-tier — the same person who authorises the exit. Gates transcripts,
   * report cards and certificates; deliberately NOT the data-protection export.
   */
  @Post("students/:studentId/documents/release")
  @RequirePermission(WORKFLOW_PERMISSIONS.STUDENT_EXIT_APPROVE)
  setDocumentRelease(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(docReleaseSchema)) body: z.infer<typeof docReleaseSchema>,
  ) {
    return this.exits.setDocumentRelease(p, studentId, body.released, body.reason);
  }

  /**
   * How long this school keeps a leaver's record before prompting a review.
   *
   * Principal-tier: it is a records-disposal policy, so it sits with the person
   * who authorises exits rather than with whoever can raise one.
   */
  @Put("students/exited/retention")
  @RequirePermission(WORKFLOW_PERMISSIONS.STUDENT_EXIT_APPROVE)
  @RequireStepUp()
  setLeaverRetention(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(retentionSchema)) body: z.infer<typeof retentionSchema>,
  ) {
    return this.exits.setRetentionYears(p, body.years);
  }

  /** Transfer / withdraw / reactivate a student's enrollment (lifecycle). */
  @Put("classes/:classId/enrollments/:studentId/status")
  @RequirePermission(LMS_PERMISSIONS.ENROLLMENT_WRITE)
  setEnrollmentStatus(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(enrollStatusSchema)) body: z.infer<typeof enrollStatusSchema>,
  ) {
    return this.lms.setEnrollmentStatus(p, classId, studentId, body.status, body.reason);
  }

  // --- academic calendar (sessions + terms) ----------------------------------
  /** What is wrong with the calendar, and what each thing has disabled. Read by
   *  anyone who can see the calendar — the consequences are not secret. */
  /** The school's grading policy plus every choice available. */
  @Get("academic/grading-policy")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  gradingPolicy(@CurrentPrincipal() p: Principal) {
    return this.academic.gradingPolicy(p);
  }

  /** Set the letter scale and/or the component weights. */
  @Put("academic/grading-policy")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  setGradingPolicy(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(gradingPolicySchema)) body: z.infer<typeof gradingPolicySchema>,
  ) {
    return this.academic.setGradingPolicy(p, body);
  }

  /** The school's year shape — drives the term-name choices and the quick-create. */
  @Get("academic/shape")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  calendarShape(@CurrentPrincipal() p: Principal) {
    return this.academic.calendarShape(p);
  }

  @Get("academic/health")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  calendarHealth(@CurrentPrincipal() p: Principal) {
    return this.academic.calendarHealth(p);
  }

  @Get("academic/sessions")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  sessions(@CurrentPrincipal() p: Principal): Promise<AcademicSessionDto[]> {
    return this.academic.listSessions(p);
  }

  @Post("academic/sessions")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  createSession(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(sessionSchema)) body: z.infer<typeof sessionSchema>,
  ) {
    return this.academic.createSession(p, body);
  }

  /** Remove a session added by mistake. Refused when current or carrying marks. */
  @Delete("academic/sessions/:id")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  deleteSession(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.academic.deleteSession(p, id);
  }

  /** Remove a term added by mistake. Refused when anything references it. */
  @Delete("academic/terms/:id")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  deleteTerm(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.academic.deleteTerm(p, id);
  }

  /** Correct a session's name or window. There was no way to do this before —
   *  a session could be created and never fixed. */
  @Put("academic/sessions/:id")
  @RequirePermission(LMS_PERMISSIONS.CLASS_WRITE)
  updateSession(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(sessionUpdateSchema)) body: z.infer<typeof sessionUpdateSchema>,
  ) {
    return this.academic.updateSession(p, id, body);
  }

  @Post("academic/sessions/:id/terms")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  addTerm(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(termSchema)) body: z.infer<typeof termSchema>,
  ) {
    return this.academic.addTerm(p, id, body);
  }

  @Put("academic/sessions/:id/current")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  setCurrentSession(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.academic.setCurrentSession(p, id);
  }

  @Put("academic/terms/:id/current")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  setCurrentTerm(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.academic.setCurrentTerm(p, id);
  }

  /** Edit a term's name/sequence/dates. Setting endDate enables auto-advance. */
  @Put("academic/terms/:id")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  updateTerm(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(termUpdateSchema)) body: z.infer<typeof termUpdateSchema>,
  ) {
    return this.academic.updateTerm(p, id, body);
  }

  /** One-click advance to the next term (or the next session's first term). */
  @Post("academic/advance-term")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  advanceTerm(@CurrentPrincipal() p: Principal) {
    return this.academic.advanceToNextTerm(p);
  }

  /** Quick-create a standard 3-term session with dated terms. */
  @Post("academic/sessions/standard")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  createStandardSession(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(standardSessionSchema)) body: z.infer<typeof standardSessionSchema>,
  ) {
    return this.academic.createStandardSession(p, body);
  }

  /** Set the current term (and session) to the one whose dates contain today. */
  @Post("academic/sync-current")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  syncCurrentTerm(@CurrentPrincipal() p: Principal) {
    return this.academic.setCurrentToToday(p);
  }

  // --- holidays / non-teaching days ------------------------------------------
  @Get("academic/holidays")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  holidays(@CurrentPrincipal() p: Principal): Promise<SchoolHolidayDto[]> {
    return this.academic.listHolidays(p);
  }

  @Post("academic/holidays")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  createHoliday(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(holidaySchema)) body: z.infer<typeof holidaySchema>,
  ): Promise<SchoolHolidayDto> {
    return this.academic.createHoliday(p, body);
  }

  @Delete("academic/holidays/:id")
  @RequirePermission(LMS_PERMISSIONS.ACADEMIC_MANAGE)
  deleteHoliday(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.academic.deleteHoliday(p, id);
  }

  // --- end-of-session promotion (maker-checker) ------------------------------
  /** Stage a promotion batch (moves nothing until approved). Maker. */
  @Post("promotions")
  @RequirePermission(LMS_PERMISSIONS.CLASS_PROMOTE)
  stagePromotion(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(promotionSchema)) body: z.infer<typeof promotionSchema>,
  ): Promise<PromotionBatchDto> {
    return this.promotion.stage(p, body);
  }

  @Get("promotions")
  @RequirePermission(LMS_PERMISSIONS.CLASS_PROMOTE)
  promotions(@CurrentPrincipal() p: Principal): Promise<PromotionBatchDto[]> {
    return this.promotion.list(p);
  }

  @Get("promotions/:id")
  @RequirePermission(LMS_PERMISSIONS.CLASS_PROMOTE)
  getPromotion(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<PromotionBatchDto> {
    return this.promotion.get(p, id);
  }

  /** Approve a promotion batch — school_admin, a DIFFERENT person than the maker. */
  @Post("promotions/:id/approve")
  @RequirePermission(LMS_PERMISSIONS.CLASS_PROMOTE_APPROVE)
  approvePromotion(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
  ): Promise<PromotionBatchDto> {
    return this.promotion.approve(p, id);
  }

  @Post("promotions/:id/reject")
  @RequirePermission(LMS_PERMISSIONS.CLASS_PROMOTE_APPROVE)
  rejectPromotion(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(promoteRejectSchema)) body: z.infer<typeof promoteRejectSchema>,
  ): Promise<PromotionBatchDto> {
    return this.promotion.reject(p, id, body.note);
  }
}
