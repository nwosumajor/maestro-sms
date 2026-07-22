# LMS learning analytics

> LMS per-class learning-analytics dashboard (completion/quiz/assignment/live + engagement signal); read-only, built + live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

LMS program feature **#10 learning analytics** — built 2026-07-11, live-verified, **UNCOMMITTED**. Read-only aggregation — NO new table/RLS/migration.

`GET /classes/:classId/analytics` (gated `lms.content.read`; service `classAnalytics` requires **staff-of-class via assertTeacherOfClass → 404** otherwise). Aggregates everything the LMS program built, in one tenant tx: studentCount, publishedContent + contentByType, completion {avgPercent, fullyComplete} (from lms_progress), per-quiz {studentsAttempted, avgPercent = mean of each student's BEST score%} (quiz_attempt), per-assignment {submitted, graded, avgPercent} (lms_submission vs body.points), live {sessions, totalJoins} (lms_live_*), and a per-student **engagement** roll-up sorted lowest-first. Pure `computeEngagementPercent(parts[])` in lms-content.util (mean of value/total ratios, capped 1, ignoring dimensions with total=0) — a SIGNAL for teacher follow-up, NEVER a verdict (Golden Rule #8; UI shows a "low" badge <33%, no penalty). `LmsAnalyticsDto` in @sms/types.

Web: dedicated SSR route `/classes/[id]/analytics` (apiGet → `LmsAnalytics` server component: stat tiles + quiz/assignment bars + engagement table); "Analytics" link on the content page header (canAuthor).

Verified live: teacher → students 1, published 5 (VIDEO1/ASSIGNMENT1/QUIZ3), completion 20%, quiz avgs match (Essay Quiz 86%=6/7), assignment 90%, live 1 join, engagement 72% = mean(1/5,2/3,1/1,1/1) ✓; student → 404. api tsc 0, web tsc 0, 22 util tests (2 new engagement), builds green, JS+CSS 200.

Same LMS program as [lms-live-classroom](lms-live-classroom.md) etc. Program now 10/12: done #1-5,#9,#12,#6,#10. Remaining: #11 engagement, #8 SCORM, #13 offline/PWA.
