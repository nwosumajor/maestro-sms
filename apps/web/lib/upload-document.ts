// =============================================================================
// Sending a file to storage — the same three steps, wherever it starts
// =============================================================================
// A family sends a birth certificate from a link in an email; a registrar scans
// one handed in at the office. Different people, different permissions, the same
// three steps — and two copies of them would drift on the details that matter:
// which failure leaves the ticket reusable, whether the size is checked before
// or after the transfer, what the person is told when the bytes never land.
//
//   1. ASK for somewhere to put it. The server writes a PENDING row first, so
//      there is something to confirm against; an upload that half-completes
//      cannot leave an object nothing knows about.
//   2. PUT the file THERE. Browser straight to storage, so a large scan never
//      passes through the API at all.
//   3. TELL the server it landed. Nothing counts as received until this
//      succeeds — the server cannot see the bucket, so this is the only moment
//      it can check the bytes are real and are what they claimed.
// =============================================================================

export type UploadOutcome = { ok: true } | { ok: false; error: string };

type Endpoints = {
  /** Where to ask for a ticket. */
  ticketUrl: string;
  /** Given the submission id, where to confirm it. */
  confirmUrl: (submissionId: string) => string;
  /** What the ticket request carries beyond the file itself. */
  body: Record<string, unknown>;
};

type Ticket = { submissionId: string; uploadUrl: string; maxBytes: number };

async function messageFrom(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string | string[] };
  const m = body.message;
  return (Array.isArray(m) ? m[0] : m) ?? fallback;
}

export async function uploadDocument(file: File, endpoints: Endpoints): Promise<UploadOutcome> {
  try {
    const ticketRes = await fetch(endpoints.ticketUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...endpoints.body, filename: file.name, contentType: file.type }),
    });
    if (!ticketRes.ok) return { ok: false, error: await messageFrom(ticketRes, "That file could not be accepted.") };
    const ticket = (await ticketRes.json()) as Ticket;

    // Checked BEFORE the transfer. The server refuses an oversized file at
    // confirm anyway, but only after it has crossed the wire — and on a phone
    // that is somebody's data.
    if (file.size > ticket.maxBytes) {
      return { ok: false, error: `That file is too large. The limit is ${Math.round(ticket.maxBytes / (1024 * 1024))}MB.` };
    }

    const put = await fetch(ticket.uploadUrl, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type },
    });
    // A failed PUT leaves the row PENDING on purpose, so the same ticket can be
    // used again rather than the person starting over.
    if (!put.ok) return { ok: false, error: "The upload did not finish. Please try again." };

    const confirm = await fetch(endpoints.confirmUrl(ticket.submissionId), { method: "POST" });
    if (!confirm.ok) return { ok: false, error: await messageFrom(confirm, "We could not accept that file.") };
    return { ok: true };
  } catch {
    return { ok: false, error: "Something went wrong sending that file. Please try again." };
  }
}
