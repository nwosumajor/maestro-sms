# Dark console theme

> Signed-in app restyled to the user's reference image (premium neutral-graphite dark console) via retuned .dark tokens + dark class on the AppShell root; homepage/login stay light; smoke 17 roles green 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

User supplied a reference screenshot (~/Pictures/Screenshots/special.png — a
dark AI-ops dashboard: near-black canvas, lifted panel cards, hairline borders,
pill status chips, icon rail) and asked for that style on the APP, excluding
homepage + login.

Implementation (token-driven, per the design-system rule):
- `globals.css` `.dark` block retuned from the old blue-tinted dark to NEUTRAL
  GRAPHITE: background 240 5% 5%, card 240 4% 8.5%, border 240 4% 16%,
  muted-fg 240 4% 63%, sidebar 240 5% 6.5%, foreground 0 0% 95%. `--primary`
  still derives from the tenant brand hue → per-school theming survives.
- Scoped by adding `dark` to the AppShell ROOT div (`data-tenant` element) —
  Tailwind darkMode:["class"] means every dark: variant + token flips inside
  the shell only. Homepage/login (outside the shell) verified UNAFFECTED.
- (student)/(teacher) route groups also render AppShell → covered.
- The shell's structure already matched the reference (sidebar groups, active
  pill + red margin rule, sticky topbar) — only the palette moved.
- The ONE intentional bg-white left: the header school-logo plate (logos need a
  light plate on dark; mirrors the reference avatar treatment).
**Theme toggle reconciliation (same day):** a PRE-EXISTING 3-way theme system
(ThemeScript pre-paint on <html> + ThemeToggle Light/Auto/Dark, localStorage
"theme") conflicted with the hardcoded shell `dark` class (toggle looked dead
in the app). Fix: hardcoded class REMOVED — html-level script owns the theme;
ThemeScript default pref changed "system"→"dark" (the console's identity);
toggle MOVED from the root layout's floating button into the AppShell topbar
(app-only); ALL public pages (/,login,onboard,welcome,reset-password,schools,
apply,careers,enroll,careers/[slug]) pinned light via `.force-light` — the
:root token block's selector is now `:root, .force-light`, re-anchoring light
tokens on that subtree even under html.dark. Also `color-scheme: light|dark`
added to the token blocks so NATIVE widgets (select dropdowns, date pickers,
checkboxes, scrollbars) follow the theme; Button/Input primitives were already
fully token-driven. Verified: script defaults dark; all public pages carry
force-light; shell class theme-neutral; toggle renders in the app topbar and
NOT on public pages; smoke admin/teacher/parent × 70 routes green. UNCOMMITTED.

**Homepage made theme-adaptive (same day):** force-light REMOVED from the
homepage root — it now follows the Light/Auto/Dark toggle, and the ThemeToggle
renders in the homepage NavBar (hidden sm:inline-flex). Audit confirmed the
page is token-clean for dark: all fixed white/neutral colors sit inside photo
overlays or deliberately-dark bands (Hero/Security/Onboard/ParentBand) and the
emerald save-% accents carry dark: variants. Login + the other public pages
REMAIN pinned light with no toggle. Verified: homepage adaptive + toggle
present, login pinned/no-toggle, smoke green.

**Login adaptive + homepage image bands (same day):** login force-light REMOVED
— the sign-in panel is token-adaptive (brand-wash is token-based, LoginForm all
tokens) with a ThemeToggle absolute top-right of the sign-in section; the photo
showcase panel is theme-free. Homepage: three flat colour sections became
FULL-IMAGE bands with dark scrims + white text + glass cards (theme-independent
like the hero): Security (hero-2 at 25% under the vault), RevenueBand
(audience-leaders, emerald accents, backdrop-blur cards), Testimonials
(audience-parents, glass quote cards, amber stars, white trust chips). Remaining
pinned-light public pages: onboard/welcome/reset-password/schools/apply/careers/
enroll. Verified: login adaptive+toggle, all three image bands render, smoke
green.
