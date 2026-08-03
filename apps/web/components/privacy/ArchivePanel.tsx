"use client";

// =============================================================================
// ArchivePanel — produce a year's archive, and fetch an old one back
// =============================================================================
// The screen that makes the archive a thing a principal can actually use. It
// existed as an API endpoint first, which meant it was not reachable by the very
// people it was built for.
//
// Two things this UI has to communicate, because getting them wrong is costly:
//
//   • WHAT IS IN THE FILE. It holds every pupil's record AND staff employment
//     details including salaries. Someone will one day be asked to "send the
//     2026 archive" to a lawyer or an investigator, and they need to know what
//     they are attaching before they attach it.
//   • THE CHECKSUM IS THE POINT. It is what lets a recipient prove years later
//     that the file was not altered. A download button that hides it throws away
//     the reason the archive is trustworthy.
// =============================================================================

import { useState } from "react";
import type { Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { sendWithStepUp } from "@/lib/stepup";
import { interpretApiError } from "@/lib/api-error";

type Archive = {
  id: string;
  label: string;
  sizeBytes: number;
  checksum: string;
  sections: Record<string, number>;
  containsHrPii: boolean;
  createdAt: string;
};

const mb = (n: number) => (n < 1_048_576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

/** A sensible default: the academic year we are currently in. */
function currentSessionLabel(): string {
  const now = new Date();
  // A school year that starts in September belongs to the calendar year it began.
  const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}/${startYear + 1}`;
}

export function ArchivePanel({ initial }: { initial: Serialized<Archive>[] }) {
  const [archives, setArchives] = useState<Serialized<Archive>[]>(initial);
  const [label, setLabel] = useState(currentSessionLabel());
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; checksum: string; label: string } | null>(null);

  async function reload() {
    const res = await fetch("/api/sms/privacy/archives");
    if (res.ok) setArchives((await res.json()) as Serialized<Archive>[]);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy("create");
    setNote(null);
    const res = await sendWithStepUp("POST", "privacy/archives", { label });
    if (res.ok) {
      const a = (await res.json()) as Serialized<Archive>;
      setNote(`Archived ${a.label} — ${mb(a.sizeBytes)}. Keep this alongside your other statutory records.`);
      await reload();
    } else {
      setNote(interpretApiError(res.status, await res.text()));
    }
    setBusy(null);
  }

  async function download(a: Serialized<Archive>) {
    setBusy(a.id);
    setNote(null);
    const res = await sendWithStepUp("POST", `privacy/archives/${a.id}/download`, {});
    if (res.ok) {
      const out = (await res.json()) as { url: string; checksum: string };
      setLink({ ...out, label: a.label });
    } else {
      setNote(interpretApiError(res.status, await res.text()));
    }
    setBusy(null);
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-1 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Year archives</h2>
        <span className="text-xs text-muted-foreground">kept indefinitely</span>
      </header>
      <p className="mb-3 text-xs text-muted-foreground">
        A snapshot of the whole school record for one session, saved so that a question asked years from now — an
        investigation, a regulator, a court — can still be answered. Take one at the end of every academic year.
        This is not a backup: backups exist to restore the system, and only reach back a year.
      </p>

      <Alert variant="info" className="mb-3">
        <AlertTitle>Handle these like a personnel file</AlertTitle>
        <AlertDescription className="text-xs">
          An archive contains every pupil&rsquo;s record <strong>and</strong> staff employment details, including
          salaries, in one readable file. Before sending one to anyone, be sure they are entitled to all of it — and
          consider whether a single pupil&rsquo;s export answers the question instead.
        </AlertDescription>
      </Alert>

      <form onSubmit={create} className="mb-3 flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <label htmlFor="arch-label" className="text-xs font-medium">
            Academic session
          </label>
          <Input
            id="arch-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="2025/2026"
            required
            className="h-8 w-40 text-sm"
          />
        </div>
        <Button type="submit" size="sm" className="h-8" disabled={busy === "create"}>
          {busy === "create" ? "Archiving…" : "Take this year's archive"}
        </Button>
        <span className="text-xs text-muted-foreground">Large schools may take a minute.</span>
      </form>

      {note && <p className="mb-2 text-xs text-muted-foreground">{note}</p>}

      {link && (
        <div className="mb-3 rounded-md border border-border bg-muted/40 p-3">
          <div className="mb-1 text-sm font-medium">{link.label} archive</div>
          <a
            href={link.url}
            className="text-sm underline"
            target="_blank"
            rel="noreferrer"
            onClick={() => setLink(null)}
          >
            Download the file
          </a>
          <p className="mt-2 text-xs text-muted-foreground">
            The link expires shortly. Record this checksum with the file — it is how anyone can prove, years later,
            that the copy they hold is the one this school produced and that nothing in it was changed.
          </p>
          <code className="mt-1 block break-all rounded bg-background px-2 py-1 text-xs">sha256:{link.checksum}</code>
        </div>
      )}

      <ul className="divide-y divide-border/70">
        {archives.length === 0 && (
          <li className="py-2 text-xs text-muted-foreground">
            No archives yet. Take one at the end of this session.
          </li>
        )}
        {archives.map((a) => {
          const rows = Object.values(a.sections ?? {}).reduce((n, v) => n + Number(v), 0);
          return (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{a.label}</span>
                  <Badge variant="secondary">{mb(a.sizeBytes)}</Badge>
                  {a.containsHrPii && <Badge variant="outline">includes staff pay</Badge>}
                </div>
                <span className="text-xs text-muted-foreground">
                  {rows.toLocaleString()} records · taken {new Date(a.createdAt).toLocaleDateString()} ·{" "}
                  <span title={a.checksum}>sha256:{a.checksum.slice(0, 12)}…</span>
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={busy === a.id}
                onClick={() => void download(a)}
              >
                {busy === a.id ? "Preparing…" : "Retrieve"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
