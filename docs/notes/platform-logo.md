# Platform logo

> MajorGBN logo is the platform default mark everywhere (homepage nav+footer, login tiles, app header fallback, favicon); a school's uploaded logo overrides it ONLY inside their own portal; verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

The user's company logo (source: ~/Documents/MajorGBN Company/Finance/logo.png —
hexagonal blue/green mark + "MajorGBN" wordmark + tagline, 1024² white bg) is
now the platform's default brand mark:
- Assets: `apps/web/public/images/platform-logo.png` (full lockup) and
  `platform-mark.png` (mark-only crop — PIL bbox-scan of the top 58%, padded
  square 426², because the full lockup is illegible at tile sizes) +
  `apps/web/app/icon.png` (256² favicon via Next App Router convention).
- Replaced the old "S"/initial tiles with the mark on a white plate
  (object-contain p-0.5, border): homepage NavBar + Footer, login mobile brand
  row + LoginShowcase fallback, AppShell header fallback.
- PRECEDENCE unchanged: a school's uploaded branding logo still wins inside
  THEIR portal (AppShell + their /login?school= page); the platform mark is
  only the fallback — and the public homepage always shows the platform mark.
- PDFs (certificates/report cards) still embed only the SCHOOL logo when set —
  no platform-logo fallback there (would brand another school's documents).
Verified: 5 mark occurrences on the homepage, login fallback, app header
fallback (demo school), /icon.png 200 image/png; smoke teacher+owner green.
UNCOMMITTED.
