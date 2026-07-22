// Client helper: POST through the BFF, transparently performing step-up re-auth
// (password → short-lived token → retry with x-stepup) when the API replies 403.
//
// SECURITY: the password is collected through CredentialPrompt (an in-app
// MASKED field), never window.prompt() — a native prompt renders plain text, so
// the password is readable by anyone next to the user, and password managers
// cannot fill it. If no prompt host is mounted the request fails closed.
import { requestCredential } from "@/components/security/CredentialPrompt";

export async function postWithStepUp(path: string, body: unknown): Promise<Response> {
  return sendWithStepUp("POST", path, body);
}

const MAX_PASSWORD_ATTEMPTS = 3;

/** Build a synthetic JSON Response so callers can read `.ok`/`.status`/`.json()`
 *  uniformly, whether the outcome came from the API or from the step-up flow
 *  itself (a cancel or a repeatedly-wrong password). */
function jsonResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ message, statusCode: status }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Like postWithStepUp but for any HTTP method (PUT/POST/PATCH/DELETE).
 *
 * On a 403 it distinguishes a genuine step-up CHALLENGE (`STEPUP_REQUIRED`) from
 * a plain permission denial: only the former prompts for a password, and it
 * RE-PROMPTS on a wrong password instead of dead-ending on the raw code. A cancel
 * or exhausted attempts returns a clear, human-readable message (not the API's
 * internal `STEPUP_REQUIRED`), so every step-up-gated screen surfaces the real
 * reason it stopped.
 */
export async function sendWithStepUp(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (payload !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`/api/sms/${path}`, { method, headers, body: payload });
  if (res.status !== 403) return res;

  // A 403 is either "you need to re-auth" or "you can't do this at all". Only the
  // former is fixable with a password, so read the body and branch. (Reading it
  // consumes the stream, so a non-step-up 403 is reconstructed for the caller.)
  const firstText = await res.text();
  if (!firstText.includes("STEPUP_REQUIRED")) {
    return new Response(firstText, { status: 403, headers: { "Content-Type": "application/json" } });
  }

  for (let attempt = 0; attempt < MAX_PASSWORD_ATTEMPTS; attempt++) {
    const pw = await requestCredential(
      attempt === 0
        ? "Enter your password to authorise this change."
        : "That password was not correct. Try again.",
    );
    if (!pw) return jsonResponse("Cancelled — your password is required to continue.", 403);

    const su = await fetch("/api/sms/security/stepup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (su.ok) {
      const { token } = (await su.json()) as { token: string };
      return fetch(`/api/sms/${path}`, { method, headers: { ...headers, "x-stepup": token }, body: payload });
    }
    // 401 = wrong password → re-prompt. Anything else (rate-limit, outage) is not
    // retriable, so surface it immediately.
    if (su.status !== 401) return new Response(await su.text(), { status: su.status });
  }
  return jsonResponse("Re-authentication failed after several attempts. Please try again.", 403);
}
