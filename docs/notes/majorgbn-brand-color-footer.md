# MajorGBN brand color & footer

> Default brand color is now the MajorGBN logo blue (hsl 203 72% 30%, was teal 184) app-wide via tokens; homepage footer expanded with Powered by MajorGBN Innovations Limited + link columns; verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

- **Brand default → logo blue**: extracted from platform-logo.png with PIL
  (navy #0a4166 hsl(204,81%,22%), mid-blue #1e7499 hsl(198,66%,36%), green
  #84cc66 hsl(102,50,60)); default set to hsl(203 72% 30%) in BOTH anchors:
  `globals.css :root --brand-h/s/l` AND `packages/tokens/src/index.ts brand`
  (keep in sync!). Dark theme derives automatically (l=52 formula). Homepage
  Security/ProductShowcase hardcoded `hsl(184 …)` accents → 203. Per-tenant
  overrides unaffected. The logo GREEN stays an imagery/emerald accent only
  (single-hue token system).
- **Footer**: 4-column layout — brand block (mark, MAESTRO-SMS wordmark, blurb,
  trust chips) + Product / For schools / For parents & careers link columns;
  bottom bar: "© YEAR MAESTRO-SMS · Powered by **MajorGBN Innovations Limited**
  — willingness to serve, readiness to lead." + posture line.
Verified: compiled CSS carries brand-h:203; footer strings render; no stray
hsl(184; smoke admin+owner green. UNCOMMITTED.
