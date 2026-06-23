// =============================================================================
// Server-side fetch for the integrity report
// =============================================================================
// Runs in a Server Component. Forwards the caller's auth (the Auth.js session
// cookie) to the NestJS API, which re-verifies the JWT and enforces
// integrity.report.read + tenant + ownership. We never pass school_id from the
// client — the API derives it from the verified token.
// =============================================================================

import type { IntegrityReportDto } from "@sms/types/integrity-report";
import { bearerForSession } from "@/lib/apiToken";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

export type ReportResult =
  | { ok: true; report: IntegrityReportDto }
  | { ok: false; status: number };

export async function fetchIntegrityReport(
  assessmentId: string,
  submissionId: string,
): Promise<ReportResult> {
  const token = await bearerForSession();
  if (!token) return { ok: false, status: 401 };
  const res = await fetch(
    `${API_BASE}/assessments/${assessmentId}/submissions/${submissionId}/integrity-report`,
    {
      headers: { Authorization: `Bearer ${token}` },
      // Integrity data is sensitive + per-request; never cache it.
      cache: "no-store",
    },
  );

  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, report: (await res.json()) as IntegrityReportDto };
}
