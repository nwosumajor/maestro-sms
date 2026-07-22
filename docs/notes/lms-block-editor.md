# LMS block editor

> LMS lessons converted from raw HTML to a structured plain-text block model (kills stored-XSS); built + live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

LMS program feature **#9 block editor** — built 2026-07-11, live-verified, **UNCOMMITTED**. Also a security fix: lesson bodies were `{html:string}` rendered via `dangerouslySetInnerHTML`, trusting only the approval gate (violates "never rely on a single layer").

Shape (NO DB/migration change — lesson body is JSONB):
- `LmsContentBody` LESSON variant changed `{html}` → `{blocks: LessonBlock[]}`. New `LessonBlock`/`LessonBlockType` in `@sms/types`: heading(level 2|3)/paragraph/bullets/numbered/code(lang?)/math(tex)/callout(tone)/quote — all PLAIN-TEXT fields.
- `lms-content.util.ts`: `normalizeBlocks` (LENIENT — drops invalid/empty/unknown blocks, never throws; used for BOTH write-validation and read) + `htmlToBlocks` (legacy `{html}` → paragraph blocks: strips tags, decodes entities). `validateBody` LESSON requires ≥1 block; **`toDto` normalizes every LESSON on read** (new→blocks, legacy html→htmlToBlocks) so the wire NEVER carries raw HTML.
- Web: new `LessonBlocks.tsx` (renders each block via React children = auto-escaped; NO dangerouslySetInnerHTML anywhere) + `LessonBlockEditor.tsx` (add/edit/reorder/remove blocks; bullets edited one-per-line). ContentManager `html` state → `blocks`.
- Math blocks show TeX source in a styled box (no KaTeX/sanitizer libs installed + flaky net → KaTeX visual render is a future pass).

Verified live: create lesson → body has `blocks` not `html`, `<script>` kept as inert verbatim TEXT, empty/unknown blocks dropped; legacy html lesson GET → converted paragraph blocks, no html field on wire, tags stripped, entities decoded. 20 util tests (6 new: normalizeBlocks XSS-as-text + htmlToBlocks strip). api tsc 0, web tsc 0, both builds green, JS+CSS 200.

Part of the same LMS program as [lms-gradebook-push](lms-gradebook-push.md). Remaining program items: #11 engagement, #12 reuse/versioning, #6 live classroom, #10 analytics, #8 SCORM, #13 offline. Deploy gotcha: `pkill -f "dist/main.js"` SELF-MATCHES the launch shell (path is in its args) → kills itself/exit 144; kill by explicit PID instead. Foreground `sleep` is blocked in this sandbox — poll instead.
