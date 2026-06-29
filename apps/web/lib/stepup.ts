// Client helper: POST through the BFF, transparently performing step-up re-auth
// (password → short-lived token → retry with x-stepup) when the API replies 403.
// Mirrors the inline pattern in BillingCheckout / StudentAdmin.
export async function postWithStepUp(path: string, body: unknown): Promise<Response> {
  return sendWithStepUp("POST", path, body);
}

/**
 * Like postWithStepUp but for any HTTP method (PUT/POST/PATCH/DELETE). On a 403
 * it prompts for the password, mints a step-up token, and retries with x-stepup.
 */
export async function sendWithStepUp(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  let res = await fetch(`/api/sms/${path}`, { method, headers, body: payload });
  if (res.status === 403) {
    const pw = window.prompt("Confirm your password to continue:");
    if (!pw) return res;
    const su = await fetch("/api/sms/security/stepup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (su.ok) {
      const { token } = (await su.json()) as { token: string };
      res = await fetch(`/api/sms/${path}`, {
        method,
        headers: { ...headers, "x-stepup": token },
        body: payload,
      });
    }
  }
  return res;
}
