# Branding logo on PDFs + audit pagination

> School logo on generated PDFs + platform-audit cursor pagination (2026-07-01)

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**School logo on certificates + report cards (2026-07-01).** Principal + school_admin
(already hold `school.branding.manage`) upload the logo; it now appears on the login
page AND on generated certificates/ID-cards/report cards.
- `StorageProvider` gained `upload({key,body,contentType})` + `download(key): Buffer|null`
  (`apps/api/src/documents/storage.provider.ts`). The STUB is now filesystem-backed
  under `os.tmpdir()/sms-storage/<key>` so upload→embed works locally; S3 provider uses
  put/getObject.
- Logo upload is now a DIRECT byte upload (was presigned-PUT): `POST /schools/branding/logo`
  takes `{contentType: image/png|image/jpeg, dataBase64}` (≤1 MB; PNG/JPEG only — what
  pdfkit embeds, excludes SVG XSS). `BrandingService.uploadLogo(p, buffer, ct)` stores via
  `storage.upload`; `getLogoBytes(schoolId)` reads it back. Web `BrandingManager` reads the
  file → base64 → POSTs (no more browser PUT to a stub URL). Removed dead `getUploadTarget`.
- `CertificateService` + `ReportCardService` inject `BrandingService` (via `BrandingModule`
  import; it already exports the service) and `doc.image(logoBuffer, …)` best-effort
  (try/catch so a corrupt image never breaks the PDF; graceful when no logo). Verified:
  cert/report-card PDFs contain 1 image XObject with a logo, 0 without; rasterized visually.

**Platform-audit cursor pagination (2026-07-01).** `PlatformAuditService.list` now returns
`PlatformAuditPageDto {entries, nextCursor}` (in `@sms/types`); keyset pagination via Prisma
`cursor:{id}, skip:1, orderBy:[{createdAt:desc},{id:desc}]`, pageSize default 50 (max 200).
`exportCsv` still exports the whole filtered set (cursor ignored, cap 2000) via a shared
private `query(f, take)`. Web `PlatformAudit` has a "Load more" button that appends the next
page. `GET /operator/audit` accepts `?cursor=`. 2 new unit tests (nextCursor + cursor passthrough).
