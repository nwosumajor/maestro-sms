# Scholarship chain

> Student-initiated scholarship requests with 4-stage approval chain (supervisor→parent→principal→platform), exam pipeline (category/mode/date), Best-Three awards — built 2026-07-17

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Scholarship module v2 (commit 1c9dd4b, live-verified end-to-end): students hold
`scholarship.apply` (also seeded to principal) and request OPEN programs with a
detailed form (`ScholarshipRequestForm` in @sms/types — reason required);
signals snapshot auto-attaches classNames/grade-avg/attendance/fees/
disciplineComplaints(againstId)/tasksCompleted(DONE).

**Key patterns:**
- Chain lives as APPLICATION STATES (PENDING_SUPERVISOR/PARENT/PRINCIPAL), NOT
  the workflow engine — stages are RELATIONSHIP-scoped (teacher-of-class via
  classTeacher×enrollment, parentChild guardian, principal role), which the
  permission-based engine can't express. One endpoint
  POST /scholarships/applications/:id/decision routes by current status; wrong
  person → 404. Parent approval WRITES consentById/At (= Golden Rule #5 consent,
  one act); parent rejection clears it.
- Legacy parent/teacher path untouched (applicantRole !== "student" submits
  straight to SUBMITTED after explicit consent) — old tests still pass.
- Platform: decide() actions REVIEW/SHORTLIST/QUALIFY/REJECT/AWARD; AWARD
  capped at SCHOLARSHIP_MAX_AWARDS=3 per program; program has category enum +
  examMode(ONLINE_CBT|GAMES|PHYSICAL)/examAt/examVenue;
  POST /scholarships/programs/:id/announce-exam notifies all QUALIFIED
  students+guardians cross-tenant (notifyFamily writes under each school's GUC).
- Portal DTO gained `pendingDecisions` (apps at MY stage); web ScholarshipPortal
  takes `roles` prop — student form, decision queues, ChainTimeline.
- Migration 20260909000000: ALTER TYPE ADD VALUE works inside Prisma's
  migration txn on PG16+ (values not used in same txn).

**Exam binding + per-position awards (commit 9c5a3b3 + migration ffc179a, live-verified):**
- announce-exam MATERIALIZES the real sitting surface, not just a notice.
  ONLINE_CBT → per-school CbtQuestionBank+CbtExam seeded from program.examQuestions
  (owner-authored [{text,options,answerIndex}]; answerIndex NEVER in any DTO —
  only examQuestionCount is exposed), tagged cbt_exam.scholarshipProgramId;
  CBT listExams/startSitting gate on a QUALIFIED application (404 else). GAMES →
  one ultimate_competition tagged scholarshipProgramId + auto-enroll each
  school + write UltimateConsent from the chain's guardian approval; ultimate
  .enter bypasses crossSchoolEnabled for a scholarship comp but requires QUALIFIED.
  Both idempotent per (program[,school]).
- collect-results harvests scores as a SIGNAL onto application.examScorePct: CBT
  score% from submitted sitting; GAMES relative standing% (fewest guesses→fastest
  elapsed) via RLS-scoped ultimate_entry_link. Operator queue ranks QUALIFIED by it.
- Per-position prizes: program.award2Minor/award3Minor (fall back to awardMinor);
  AWARD takes position 1|2|3, granted ONCE each, still ≤3 total; application
  .awardPosition recorded.
- Web: operator gains prize fields, CBT duration, inline question composer
  (appendQuestion PUT — answers never round-trip to client), announce/collect,
  score-ranked queue, position picker. Student QUALIFIED card deep-links /cbt or
  /games/ultimate + shows examScorePct. Migration 20260910000000 (columns only).
- GOTCHA: `docker compose restart` does NOT rebuild — migration files are baked
  into the image at build time. A new migration needs `compose build backend`.
  Also the CBT sitting-view DTO field is `sittingId` not `id`; ultimate
  controller base path is `/ultimate` not `/games/ultimate`.

Related: [revenue-program](revenue-program.md) (homepage ScholarshipBand marketing + CBT/games modules).
