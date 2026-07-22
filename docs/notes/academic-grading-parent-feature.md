# Academic grading + parent feature

> Term-weighted grading + subject-selection maker-checker + grade-publish approval + initiator-routed workflows + parent portal — all BUILT & live-verified, UNCOMMITTED (2026-07-04)

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Big academic feature built over one session (2026-07-04), all live-verified
against the dev stack, **all UNCOMMITTED** (sits on top of the equally-uncommitted
[july-2026-hardening-sweep](july-2026-hardening-sweep.md)). Reuses the local-dev env recipe there
(major_user:majorpw@localhost:5434, migrate postgres:verify@5434, API_PORT 3001).

**Phase 1 — term-weighted grading.** Pure engine in `@sms/types` `grading.ts`
(`computeTermSubjectGrade`: exam 60 / midterm 20 / assignment 10 / class-note 10,
weights are asserted-sum-100 constants). New tenant table `subject_result`
(migration `20260727000000_subject_result`, RLS `47_*`, NO DELETE — grades are
records). `TermResultService` + `/term-results/*` routes: subject-teacher grading
roster, upsert component scores (server recomputes total), scoped session report
(student→self, parent→children PUBLISHED-only, class staff→all). Web `/gradebook`
(nav "Grades", GRADEBOOK module) — `GradingConsole` + `ReportCard`. Reuses existing
`grade.read`/`grade.write`.

**Grade publishing is MAKER-CHECKER.** Publish does NOT flip live: it claims the
batch DRAFT→PENDING_APPROVAL and raises a `GRADE_PUBLISH` workflow (new type,
systemOnly) on `GRADE_PUBLISH_CHAIN` = head teacher (`workflow.review.head`) →
principal (`workflow.review.principal`). The `WorkflowHooks.onFinalized` reactor
flips PENDING_APPROVAL→PUBLISHED (APPROVED) or →DRAFT (REJECTED) in-tx. Editing a
pending batch is 409; editing a PUBLISHED grade reverts it to DRAFT (re-approval).

**Workflow engine — initiator-routed chains (user-requested add-on).**
`WorkflowStage` gained optional `approverId`/`approverName`. `createRequest` accepts
`approverIds` (2–3, `CUSTOM_CHAIN_MIN/MAX_STAGES`); `buildCustomChain` validates
distinct + reviewer-capable (holds `workflow.review`) + not-self. A ROUTED stage is
person-locked: only the named approver may APPROVE/REJECT/REQUEST_REVISION (else
403 "routed to X"). `GET /workflows/approvers` lists eligible senior staff (excludes
caller). System chains (GRADE_PUBLISH, FEE_SCHEDULE) can't be routed. Principal +
school_admin still SEE every request (listRequests wide for reviewers) — confirmed.
Web `WorkflowInbox` got the "Route approvals to" picker.

**Phase 2 — subject selection maker-checker.** New table `subject_selection`
(migration `20260728000000_subject_selection`, RLS `48_*`, NO DELETE; unique
(termId, studentId)). Student picks from the class's ClassSubjectTeacher offerings
→ `SubjectSelectionService`: stage-1 = the class's SPECIFIC supervisor
(`Class.supervisorId`, a named person — on-row maker-checker like admissions, NOT
the role-based engine; skipped if no supervisor) → stage-2 = `subject.selection.approve`
(school_admin/head_teacher, a DIFFERENT person). PENDING_SUPERVISOR→PENDING_ADMIN→
APPROVED|REJECTED, optimistic updateMany guard, REJECTED resubmits in place. **APPROVED
selections then GOVERN the grading roster** (`TermResultService.subjectTakers`): roster
narrows to students whose approved pick includes the subject; grading a non-taker →404.
Falls back to full enrollment when no selections exist. New perms `subject.select`
(student), `subject.selection.approve` (school_admin/head_teacher). Web `SubjectPicker`
+ `SelectionReview` on `/gradebook`.

**Phase 3 — parent portal.** New perm `family.read` (parent). `ParentService` +
`GET /family/overview` (SIS module) — ONE read scoped ENTIRELY through ParentChild,
aggregating per child: attendance % (groupBy), PUBLISHED term-grade averages, discipline
complaints (againstId=child, STUDENT), task assignments, outstanding fees (open invoices
− POSTED payments, REFUND subtracts). Guardian read audit-logged. NO new table (reads
existing) → no RLS file. Web `/family` ("My children" nav).

**Parent ONBOARDING (user follow-up).** Parents can now be CREATED (were only
linkable before). New perm `parent.import` (school_admin/principal/hr_manager/hr_clerk).
`ParentImportService` (`apps/api/src/parent/parent-import.*`): (a) single
`POST /admin/parents` — create parent User+parent role+one-time password (forced reset,
passwordChangedAt=null) or reuse an existing email, link to studentIds; (b) bulk
maker-checker mirroring student-import — new table `parent_import_batch` (migration
`20260729000000_parent_import`, RLS `49_*`, NO DELETE), stage PENDING → a DIFFERENT
person approves → creates accounts (idempotent on email) + ParentChild links. Children
referenced by admission number and/or student email (";"-separated), resolved in-tenant;
unmatched refs counted, not fatal. Credentials returned ONCE (never persisted). Web
`/admin/parents` (`ParentOnboard`: single form w/ child picker + bulk CSV + login-slip
CSV download, formula-guarded) + admin-dashboard quick-action. NOT step-up gated (matches
student-import). Verified: parent-onboard live smoke 12/12 (single create→login→sees child
on /family, idempotent reuse, bulk stage→SoD self-approve blocked→2nd admin approves→
accounts+links+creds, bulk parent logs in + sees child). `parent.import` granted to live
DB + seed.ts.

**Totals now: full API jest 504/504 (72 suites); 4→5 live smokes; new tenant tables
subject_result / subject_selection / parent_import_batch each with RLS + e2e case.**

Verified: full API jest **496/496 (71 suites)** incl. new RLS cross-tenant cases for
both new tables (coverage gate green) + unit suites (term-grade pure, term-result
scoping, subject-selection 2-stage, workflow routed chains, parent scoping). Web
typecheck + production build (`/gradebook`, `/family` compile). Four live smokes all
green: grade-publish (16), routed-chains (12), subject-selection (14), family (12 incl.
cross-tenant isolation). Demo school left configured: session 2026/2027 + 3 terms (First
current), Math/English offerings on History 101 (class 5555…), teacher@ as its supervisor.

Perms were granted to the LIVE demo DB via targeted SQL (full re-seed would clobber the
demo's ULTIMATE plan) AND added to `seed.ts` for fresh installs. Fixed one stale
pre-existing spec (operator subscription e2e expected old ENTERPRISE default → now the
fail-closed STANDARD floor).
