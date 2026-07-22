# Careers CV upload

> Public careers CV upload — PDF-only (magic-byte checked), 5 MB multer cap, storage-provider bytes, audited HR download; API-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**Careers CV upload (user-requested, 2026-07-12)** — built + API-verified, **UNCOMMITTED**.

`applicant` gained `cvKey`/`cvName` (migration `20260823000000_applicant_cv`, applied to live DB; no new RLS — applicant already covered). Bytes go to the pluggable **StorageProvider** (`storage.upload/download` — the server-side methods the branding logo uses; S3/R2 in cloud, filesystem stub locally), key `careers/{schoolId}/{uuid}.pdf` — never in Postgres. **HrModule now binds STORAGE_PROVIDER** (same stub/s3 switch as LmsModule).

Public apply (`POST /public/careers/:slug/apply`) now accepts **multipart** with optional `cv` field via `FileInterceptor` (memory storage, **limits.fileSize 5 MB → 413 before the handler**, mimetype filter application/pdf → 400) **plus a server-side `%PDF-` magic-byte check** in the service (a script renamed .pdf → 400). JSON bodies (no file) pass through the interceptor untouched — both content types work. Upload happens BEFORE the applicant tx; on failure (dup 409 etc.) the object is deleted best-effort. `ApplicantDto.cvName`.

HR download: `GET /hr/recruitment/applicants/:id/cv` (hr.recruit.manage, **audited `hr.recruit.cv.download` — CV is PII**) streams the PDF; 404 when no CV. Web: CareersBoard file input (accept=pdf, client 5 MB pre-check, FormData submit) + "CV" link on ATS applicant rows. **The public BFF catch-all proxy was fixed to forward the ORIGINAL content-type + raw bytes** (it previously forced application/json and read text — multipart would have been mangled).

API-verified (7 checks): multipart apply 201 + stage APPLIED; JSON apply still 201; fake-PDF magic → 400; wrong mimetype → 400; 6 MB → **413 File too large**; HR download 200 application/pdf **bytes exactly match the upload**; no-CV applicant → 404 + cvName null. recruitment spec 4/4 (mock gained storage), api+web tsc 0, both built + deployed.

PENDING (sandbox Bash-approval outage at session end): one through-the-web-proxy multipart request + route smoke — script ready at `scratchpad/verify-cv-web.mjs`. The browser path itself is what users exercise at /careers/demo.
