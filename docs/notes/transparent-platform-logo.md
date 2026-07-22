# Transparent platform logo

> platform-logo/platform-mark/icon.png rebuilt with TRANSPARENT background from the source logo (near-white→alpha incl. enclosed glyph counters, edge de-halo via un-compositing); the 5 platform-mark display sites drop bg-white plates (school logos keep theirs); verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Follows [platform-logo](platform-logo.md). User: "remove the white background in the logo".
Source stays `/home/ayodele-nwosu/Documents/MajorGBN Company/Finance/logo.png`
(RGB on white). Rebuild recipe (PIL only — no numpy/scipy on this machine):
- GLOBAL near-white (all channels ≥232) → alpha 0. Connectivity flood-fill was
  tried first but WRONGLY preserved enclosed glyph counters (white dots in
  "o"/"B" on dark) — the artwork has no intentional white, so global is right.
- Pixels 8-adjacent to transparent: alpha = 255−min(r,g,b), color
  UN-COMPOSITED from white ((c−(255−a))·255/a) — kills the light halo on dark.
- platform-logo.png = trimmed full lockup (768×675, 24px pad).
- platform-mark.png = emblem-only crop: row-scan alpha blocks MERGED when gap
  <30px (the hexagon's internal leaf gap ~15px splits it otherwise), squared
  434×434. icon.png = LANCZOS 256 of the mark.
- Display sites: AppShell header, homepage nav + footer, login mobile header
  now render the mark BARE (`h-N w-N object-contain`, no plate/border);
  LoginShowcase uses a glass tile (bg-white/10 + backdrop-blur) over photos.
  School-UPLOADED logos keep their bg-white plates (unknown artwork).
Verified: served PNGs RGBA with corner alpha 0; owner+admin × 70 routes green.
UNCOMMITTED.
