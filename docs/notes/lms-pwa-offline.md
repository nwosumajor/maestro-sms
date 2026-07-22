# LMS PWA/offline

> PWA/offline — installable manifest + security-conscious service worker (static-only cache, network-only /api, offline fallback); built + browser-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

LMS program feature **#13 offline/low-bandwidth PWA** — built 2026-07-11, browser-verified via CDP, **UNCOMMITTED**. The FINAL feature — the whole 12-item LMS enhancement program (all except #7 AI, which the user excluded) is now DONE. No API/DB change.

Files (all in `apps/web/public/` + layout + one client component):
- `manifest.webmanifest` (installable: name/short_name/standalone/theme_color + `/icon.svg`), `icon.svg` (SVG monogram), `offline.html` (self-contained styled fallback), `sw.js` (service worker).
- `components/pwa/ServiceWorkerRegister.tsx` (client) registers `/sw.js` on load + shows an offline banner (online/offline events). Wired into `app/layout.tsx` (body) + `metadata.manifest`/`icons`/`appleWebApp` + `export const viewport` themeColor.

**SECURITY posture (multi-tenant, minors' PII — the key design choice):** the SW caches ONLY content-hashed static assets (`/_next/static`, `/images`, fonts → cache-first = the low-bandwidth win). `/api/*` is **network-only** (never cached — no tenant-data remnants on a shared device). Authenticated navigations are network-first with the STATIC `offline.html` as the ONLY fallback — rendered student PII is never persisted. Precache = offline.html + icon + manifest.

Verified with headless chromium over raw CDP (Node 24 global WebSocket; `scratchpad/pwa-*.mjs`): (1) SW state=activated; (2) `sms-static-v1` cache populated + offline.html precached; (3) page SW-controlled after reload; (4) **real offline test** — killed the web server, navigated → served the "You're offline" fallback ✔; (5) **0 `/api/*` entries in cache** ✔. NOTE: DevTools `Network.emulateNetworkConditions offline` and `setBlockedURLs` do NOT reliably block loopback for a SW — the decisive offline test is to actually kill the :3000 server. Web build >2min (Bash timeout 300000); manifest served as application/manifest+json, sw.js as application/javascript.

Program COMPLETE — see [lms-gradebook-push](lms-gradebook-push.md) [lms-block-editor](lms-block-editor.md) [lms-reuse-versioning](lms-reuse-versioning.md) [lms-live-classroom](lms-live-classroom.md) [lms-learning-analytics](lms-learning-analytics.md) [lms-engagement-badges](lms-engagement-badges.md) [lms-xapi-lrs](lms-xapi-lrs.md). Everything UNCOMMITTED.
