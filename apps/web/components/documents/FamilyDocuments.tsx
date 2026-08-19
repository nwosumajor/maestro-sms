"use client";


// =============================================================================
// The page a family lands on from the link the school sent them
// =============================================================================
// No account, no password. The token in the URL is the whole credential, so the
// page can do exactly two things: show what is still wanted, and send files in.
// It cannot open anything already uploaded — a link forwarded to a WhatsApp
// group must not become a way to read a child's birth certificate.
//
// It lives under /apply because /documents is a signed-in area: a public page
// there would bounce every parent to a login screen they have no account for.
//
// The upload goes BROWSER → BUCKET on a presigned URL, so a large scan never
// passes through the API. Three steps, and the middle one is the only one that
// carries the file: ask for a URL, PUT to it, then tell the school it landed.
// =============================================================================

import * as React from "react";
import { uploadDocument } from "@/lib/upload-document";

type Requirement = { id: string; label: string; description: string | null; mandatory: boolean };
type Sent = { requirementId: string | null; label: string | null; status: string; rejectedReason: string | null };
type Checklist = {
  childName: string;
  requirements: Requirement[];
  submitted: Sent[];
  outstanding: Requirement[];
  complete: boolean;
};

const WORD: Record<string, string> = {
  UPLOADED: "Received",
  VERIFIED: "Accepted",
  REJECTED: "Please send again",
  WAIVED: "Not needed",
};

export function FamilyDocuments() {
  const [token, setToken] = React.useState<string | null>(null);
  const [data, setData] = React.useState<Checklist | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Read on the client: the token must not end up in a server log or a
    // referrer header any earlier than it has to.
    const t = new URLSearchParams(window.location.search).get("token");
    setToken(t);
    if (!t) {
      setLoadError("This link is missing its code. Use the link the school sent you.");
      return;
    }
    void refresh(t);
  }, []);

  async function refresh(t: string) {
    const res = await fetch(`/api/public/documents/checklist?token=${encodeURIComponent(t)}`);
    if (!res.ok) {
      setLoadError("This link is not valid or has expired. Ask the school for a new one.");
      return;
    }
    setData((await res.json()) as Checklist);
    setLoadError(null);
  }

  async function send(requirementId: string, file: File) {
    if (!token) return;
    setBusy(requirementId);
    setError(null);
    setDone(null);
    // The SAME uploader the office uses. Two copies would drift on exactly the
    // details that matter — which failure leaves the ticket reusable, when the
    // size is checked, what the person is told when nothing lands.
    const out = await uploadDocument(file, {
      ticketUrl: `/api/public/documents/upload-url?token=${encodeURIComponent(token)}`,
      confirmUrl: (id) => `/api/public/documents/${id}/confirm?token=${encodeURIComponent(token)}`,
      body: { requirementId },
    });
    setBusy(null);
    if (out.ok) {
      setDone("Sent. The school will check it.");
      await refresh(token);
    } else setError(out.error);
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-xl font-semibold">Documents</h1>
        <p className="mt-3 text-sm text-muted-foreground">{loadError}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Documents for {data.childName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {data.complete
            ? "Everything the school needs has been received. Thank you."
            : "Please send the documents below. A clear photograph is fine — PDF, JPEG or PNG, up to 10MB each."}
        </p>
      </header>

      {error && <p className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm">{error}</p>}
      {done && <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">{done}</p>}

      {data.outstanding.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Still needed</h2>
          {data.outstanding.map((r) => (
            <div key={r.id} className="rounded-md border border-border p-4">
              <p className="font-medium">
                {r.label}
                {!r.mandatory && <span className="ml-2 text-xs text-muted-foreground">(optional)</span>}
              </p>
              {r.description && <p className="mt-1 text-sm text-muted-foreground">{r.description}</p>}
              <input
                type="file"
                className="mt-3 block w-full text-sm"
                accept="application/pdf,image/jpeg,image/png"
                disabled={busy === r.id}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void send(r.id, file);
                  e.target.value = "";
                }}
              />
              {busy === r.id && <p className="mt-2 text-sm text-muted-foreground">Sending…</p>}
            </div>
          ))}
        </section>
      )}

      {data.submitted.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Already sent</h2>
          {data.submitted.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
              <span className="font-medium">{s.label ?? "Document"}</span>
              <span className="ml-auto text-sm text-muted-foreground">{WORD[s.status] ?? s.status}</span>
              {/* The school's own words, so a family knows what to do rather
                  than sending the same file again. */}
              {s.rejectedReason && <p className="w-full text-sm text-rose-600 dark:text-rose-400">{s.rejectedReason}</p>}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
