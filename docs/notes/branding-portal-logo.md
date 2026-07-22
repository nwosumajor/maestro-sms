# Branding portal logo

> School logo now shows in the signed-in AppShell for ALL staff (new member endpoint) + logo shape/size validation (square, 128–2048px); live-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Session 2026-07-13: completed the "principal uploads logo → whole school sees it"
story on top of the existing [branding-logo-and-audit-pagination](branding-logo-and-audit-pagination.md) work.

- **`GET /schools/branding/me`** — NEW authenticated-only route (no
  `@RequirePermission`; the global guard still authenticates) returning
  `MemberBrandingDto` (schoolName, logoUrl, theme). Logo hidden when the
  subscription is out of good standing, mirroring the public login route.
  Fixes a latent bug: AppShell previously fetched the manage-gated
  `/schools/branding`, so theme silently 403'd for non-admin staff.
- **Logo shape/size contract** in `@sms/types/dto/branding.ts`:
  `isValidLogoDimensions` (square within 10%, 128–2048px/side, FP-safe —
  `|w−h| ≤ tol·h`, NOT `w/h−1`), `LOGO_SHAPE_REQUIREMENT` string. Server parses
  real bytes via `apps/api/src/branding/image-dimensions.ts` (PNG IHDR / JPEG SOF
  walk, no image lib); client pre-checks via `createImageBitmap` in
  `BrandingManager`. 7 unit tests (`image-dimensions.spec.ts`).
- **AppShell** renders the logo (h-8 img, presigned URL) in the header for every
  member, falling back to the initial-letter tile.
- Verified live: teacher sees member branding 200 + manage 403; 800×400 / 64×64 /
  fake-bytes uploads → 400 with the shape message; 512×512 → 201 and the teacher
  then sees logoUrl. Full route smoke: 69 routes × 17 roles green. UNCOMMITTED.
- **In this local DB, owner@sms.platform's schoolId = St. Andrews** (the
  platform-org model isn't reflected in the seeded data here) — don't read a
  cross-tenant "leak" into owner seeing St. Andrews branding.
- British Elshaddi staff (ojukwu@/wisdom@britishehs.com) do NOT use password123.
