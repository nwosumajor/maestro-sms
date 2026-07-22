# Branding logo location + certificate redesign

> Answered 'where is the logo uploaded' (/admin/branding, was orphaned from nav) + rebuilt certificate/ID-card PDFs from bare pdfkit to professional vector templates; COMMITTED ce6f0e5

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

2026-07-20 session. Two-part request: locate the logo-upload console, and make
generated certificates/ID cards look professional.

- **Logo upload**: `/admin/branding` (`BrandingManager`, gated
  `school.branding.manage` — principal/school_admin) was fully built and
  functional but had **no link anywhere in the UI** — not in the AppShell nav,
  not on the `/admin` quick-actions list. Added it as an `/admin` quick action
  ("School branding") and clarified the page subtitle to say where the
  logo/colour actually surface (login page, app header, certificates, ID
  cards, report cards) — it wasn't obvious from the old copy that certificates
  consumed it too.
- **Certificate/ID-card redesign** (`apps/api/src/certificate/certificate-templates.ts`,
  new pure module, replaces two inline private renderers in
  `certificate.service.ts`): everything is hand-drawn with pdfkit vector
  primitives (no external assets) — engraved multi-rule border + corner
  flourishes, translucent monogram watermark, scalloped double-ring official
  seal with ribbon tails, flanking signature blocks (issuing officer +
  principal — now resolved server-side from the school's actual `principal`-
  role user), flourished name underline, per-type default titles/citations
  (COMPLETION/PARTICIPATION/MERIT). ID card is now two-sided (CR80): gradient
  header, logo plate, photo placeholder, role chip, monospaced unique-id,
  decorative serial barcode, conditions-of-use back page.
- **Branding-aware**: both templates take an `accent` hex derived from the
  school's `SchoolBranding` HSL row (`hslToHex`, pure + unit-tested exact) —
  every school's documents are on-brand automatically. No logo uploaded ->
  drawn monogram medallion fallback, never a blank header. See
  [branding-portal-logo](branding-portal-logo.md) for the underlying upload/theme plumbing this reuses.
- Iterated the design via actual PDF review (rendered samples locally, read
  them back as PDF documents mid-session) — caught and fixed a seal-ribbon
  overlap and photo-placeholder vertical centering before shipping.
- **Unrelated interruption mid-session**: the HOST docker daemon restarted on
  its own (visible in `journalctl -u docker`, not caused by any command run
  here) and cleanly stopped every container (exit 0) including `sms-test-pg`.
  Recovery was just `docker compose up -d` + `docker start sms-test-pg` — no
  data loss, but worth knowing this can happen mid-session on this host.

Verified: 7 new unit tests (`certificate-templates.spec.ts`), full API suite,
tsc clean, LIVE issuance against the running compose stack (both a MERIT
certificate and an ID card pulled out and visually inspected), 87-route x
4-role SSR smoke including the newly-linked `/admin/branding` page.
COMMITTED as ce6f0e5 (stacks on [csp-timetabling](csp-timetabling.md) 2c66a2b/45a7bbf), not
pushed.
