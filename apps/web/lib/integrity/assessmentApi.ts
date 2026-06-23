// =============================================================================
// Server-side fetch for the student assessment-taking screen
// =============================================================================
// Runs in a Server Component. The API resolves — from the verified JWT — the
// assessment, the caller's own submission, and the integrity configuration
// (toggles, NDPR consent, and whether an active StudentIntegrityExemption
// applies). The web layer NEVER decides consent/exempt itself; it only renders
// what the server says. school_id never crosses from the client.
// =============================================================================

import type { IntegrityClientConfig } from "@/lib/integrity/hooks";
import { bearerForSession } from "@/lib/apiToken";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";
// Browser-facing base: the same-origin BFF proxy, which injects auth server-side
// (so the browser never holds a verifiable API token). See app/api/sms/[...path].
const PUBLIC_API_BASE = "/api/sms";

export interface AssessmentTakeData {
  assessmentTitle: string;
  timeRemainingLabel: string;
  initialContent: string;
  integrity: IntegrityClientConfig;
}

interface ApiResponse {
  assessmentId: string;
  submissionId: string;
  assessmentTitle: string;
  timeRemainingLabel: string;
  initialContent: string;
  integrityEnabled: boolean;
  consentGranted: boolean;
  exempt: boolean;
  toggles: { pasteCapture: boolean; focusTracking: boolean; typingCadence: boolean };
}

export type TakeResult =
  | { ok: true; data: AssessmentTakeData }
  | { ok: false; status: number };

export async function fetchAssessmentForTaking(
  assessmentId: string,
): Promise<TakeResult> {
  const token = await bearerForSession();
  if (!token) return { ok: false, status: 401 };
  const res = await fetch(`${API_BASE}/assessments/${assessmentId}/take`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) return { ok: false, status: res.status };

  const r = (await res.json()) as ApiResponse;
  return {
    ok: true,
    data: {
      assessmentTitle: r.assessmentTitle,
      timeRemainingLabel: r.timeRemainingLabel,
      initialContent: r.initialContent,
      integrity: {
        apiBaseUrl: PUBLIC_API_BASE,
        assessmentId: r.assessmentId,
        submissionId: r.submissionId,
        integrityEnabled: r.integrityEnabled,
        consentGranted: r.consentGranted,
        exempt: r.exempt,
        toggles: r.toggles,
      },
    },
  };
}
