// Client helper: POST through the BFF, transparently performing step-up re-auth
// (password → short-lived token → retry with x-stepup) when the API replies 403.
// Mirrors the inline pattern in BillingCheckout / StudentAdmin.
export async function postWithStepUp(path: string, body: unknown): Promise<Response> {
  const payload = JSON.stringify(body);
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  };
  let res = await fetch(`/api/sms/${path}`, init);
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
        method: "POST",
        headers: { "Content-Type": "application/json", "x-stepup": token },
        body: payload,
      });
    }
  }
  return res;
}
