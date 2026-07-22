# MajorGBN two-tone brand

> Brand refined to TWO logo colors: deep navy primary hsl(205,68%,26%) + logo-green --accent-2/brand2 for affirmative accents; dark primary softened (s-16, l48); homepage checks/trial-chip green; live-verified + 17-role smoke green 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

User feedback: single logo blue "too bright" — wanted a mix. Implementation:
- Primary DEEPENED to the wordmark navy: `--brand-h/s/l = 205/68%/26%` in
  globals.css AND `packages/tokens brand` (keep in sync). Dark-theme primary
  formula softened: `calc(var(--brand-s) - 16%) 48%` (was -8/52 — less neon).
- NEW second accent token `--accent-2` (logo leaf green): light `102 40% 40%`,
  dark `102 42% 58%`; exposed in Tailwind as `brand2`
  ("hsl(var(--accent-2) / <alpha>)"). Use for AFFIRMATIVE detail only —
  checkmarks, trust chips, positive highlights; navy owns buttons/nav/links.
- Homepage: all list CheckIcons text-primary→text-brand2, footer mini-checks,
  and the free-trial chip (border-brand2/30 bg-brand2/10 text-brand2).
- Per-tenant overrides only move --brand-h/s/l; --accent-2 is platform-fixed.
Verified live: compiled CSS carries brand-h:205 + both --accent-2 values, no
stray 203/184; homepage renders 28 text-brand2 accents + green trial chip +
MajorGBN footer; typecheck 13/13; 17-role × 70-route smoke green. Servers
restarted (API by5qja9wd, web bt7mw84cc). UNCOMMITTED.
