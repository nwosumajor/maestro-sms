# SMS — Design System & Screen Brief (for visual exploration)

Multi-tenant School Management System. This brief drives **visual exploration
only**. Shipped UI is rebuilt in shadcn/ui + the tokens below; generated screens
are never the foundation. Per-tenant theming = swap the brand hue, nothing else.

## Brand & tone
Trustworthy, calm, professional, low-anxiety. This software handles minors' data
and academic-integrity signals — it must feel **fair and transparent, never
punitive or surveillance-y**. Generous white space, clear hierarchy, restrained
color. Accessible by default (WCAG AA).

## Color tokens (HSL)
Default brand: **deep academic teal** `hsl(184 68% 31%)` (`--brand-h/s/l` — the only per-tenant variable; see `apps/web/app/globals.css` for the live values). Canvas is cool paper `200 24% 98%`; ink is cool slate `200 18% 14%`.
- background `0 0% 100%` / foreground `222 47% 11%`
- card `0 0% 100%` / muted `220 14% 96%` / muted-foreground `220 9% 46%`
- border `220 13% 91%`
- primary = brand; primary-foreground `0 0% 100%`
- destructive `0 72% 51%`
- Dark mode: slate `222 47% 7%` bg, `210 20% 96%` fg.

### Integrity severity (CONSTANT across tenants — priority, not guilt)
- INFO  → bg `220 14% 96%`, fg `220 39% 30%` (neutral)
- LOW   → bg `48 96% 89%`,  fg `28 74% 26%` (amber)
- MEDIUM→ bg `34 100% 92%`, fg `22 82% 31%` (orange)
- HIGH  → bg `0 86% 95%`,   fg `0 70% 35%` (red)
Severity is a review **priority**, never an accusation. High = "look first".

## Type
- Display: **Spectral** (serif — page h1s, hero, KPI numerals; the "register"
  voice; bound via next/font as `--font-display`). Sans: **Inter** (body/UI).
  Mono: **JetBrains Mono** (evidence values/metrics).
- NOTE: the `--font-*` variables are bound ONLY by next/font in `layout.tsx` —
  never redeclare them in `:root` (a later declaration silently beats
  next/font's class and disables the loaded webfonts).

## Signature motif
- Squared exercise-book grid (public hero/login) + the **red margin rule**
  `--rule: 356 62% 55%` — a decorative accent only (active-nav indicator, login
  margin line, KPI tick). NEVER on buttons/alerts; kept distinct from
  `--destructive`, and NOT tenant-overridable.
- Scale: xs .75 / sm .875 / base 1 / lg 1.125 / xl 1.25 / 2xl 1.5 / 3xl 1.875 rem.
- Weights: 400 / 500 / 600 / 700. Headings 600.

## Shape & spacing
- Radius base `0.625rem` (md = -2px, sm = -4px). Soft, not pill.
- 4px spacing grid. Cards: 1px border, subtle shadow, comfortable padding.

## Components (shadcn/ui)
Card, Alert, Badge, Button, Textarea, Table, Tabs, Tooltip. Badges carry
severity. Alerts carry disclosures (calm, informational — not red warnings).

---

# Screen 1 — Assessment (student, taking a test)
A focused, distraction-light writing surface.
- Header: assessment title, time remaining, save status ("Saved just now").
- **Integrity monitoring banner** (only when active): calm info Alert, NOT a
  warning. States plainly what's recorded ("paste attempts — length only, never
  content; when you leave the tab; typing rhythm — timing only") and that these
  are signals for a teacher, **never an automatic penalty**. Mentions exemptions
  for assistive tech. This must feel honest and reassuring, never threatening.
- Large answer Textarea (prose) with autosave. A subtle "pasting is off for this
  answer" helper line when paste friction is on.
- Primary action: Submit. Secondary: Save draft.
- States to show: monitoring-on vs monitoring-off (plain field, no banner).

# Screen 2 — Integrity Report (teacher, reviewing one submission)
Aggregated signals + evidence for a human decision. Read-only evidence view.
- Header: assessment title, student (or pseudonymous id), submission status/time.
- **Prominent, calm disclaimer** at top, verbatim in spirit: "These are signals
  for your review, not proof of misconduct. The system takes no automatic action
  and assigns no penalty. Any decision is yours and will be logged separately."
- Summary row: total signals + severity counts as badges (High/Medium/Low/Info).
- Signal list as cards, newest first. Each card: signal type (Paste / Left the
  tab / Typing pattern / Similarity / Draft history), source chip (Client/Server),
  severity badge, detector + confidence %, timestamp, and an **evidence** block
  rendered as labeled key/value pairs in mono (e.g. "largest paste share 0.62",
  "match score 0.91", "drafts 1"). Never shows another student's content.
- NO "penalize" / "flag as cheating" button anywhere. The only actions are
  navigational (back to class, open submission) — consequences happen elsewhere.
- Empty state: "No integrity signals were recorded for this submission."
- Show one HIGH-severity example and the empty state.

## Layout
App shell: left nav (Dashboard, Classes, Assessments, Students), top bar with
school name + brand mark (tenant-themed), user menu. Content max-width ~960px,
centered, generous margins.
