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
import { useFormat } from "@/components/shell/RegionProvider";
import type { AcademicSessionDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  scope: { kind: "session" | "term"; from: string; to: string } | null;
};

const mb = (n: number) => (n < 1_048_576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

/**
 * What an archive can be taken OF.
 *
 * // GOTCHA: this used to be a typed label plus a guess. The guess read
 * `now.getMonth() >= 7` off the BROWSER's clock and assumed a September start —
 * wrong for a school whose year opens in January, and wrong about "now" for
 * anyone whose device is in a different zone from the school (the rule this
 * repo keeps relearning: today is the SCHOOL's day, not the reader's).
 *
 * More importantly the label bounded NOTHING. `POST /privacy/archives` takes
 * `sessionId`/`termId` and that is what scopes the export — so a typed
 * "2025/2026" produced a whole-school dump wearing one year's name. Measured on
 * the demo school: 99 MB against 82.5 MB scoped, 173,701 attendance rows
 * against 169,200, and 41,213 audit rows against 3,341 — twelve times the audit
 * trail, from years either side of the one on the label.
 *
 * A picker over what the school ACTUALLY has cannot express any of that: every
 * option carries the id that bounds it, so the name and the contents agree by
 * construction.
 */
type Scope =
  | { kind: "session"; id: string; label: string; dated: boolean }
  | { kind: "term"; id: string; label: string; dated: boolean }
  | { kind: "all"; id: "all"; label: string; dated: true };

function scopesOf(sessions: Serialized<AcademicSessionDto>[]): Scope[] {
  const out: Scope[] = [];
  // Newest first: the archive somebody wants is almost always the year just
  // ended, and it should not be at the bottom of a fifteen-year list.
  const ordered = [...sessions].sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));
  for (const s of ordered) {
    // A session or term with no dates CANNOT be scoped — the API refuses it
    // rather than silently widening. Shown, and disabled, with the reason: a
    // missing option sends someone hunting for a session they can see on the
    // calendar page.
    out.push({ kind: "session", id: s.id, label: s.name, dated: Boolean(s.startDate && s.endDate) });
    for (const t of [...(s.terms ?? [])].sort((a, b) => a.sequence - b.sequence)) {
      out.push({
        kind: "term",
        id: t.id,
        label: `${s.name} · ${t.name}`,
        dated: Boolean(t.startDate && t.endDate),
      });
    }
  }
  // The whole school is a REAL answer — it is what a school closing down, or
  // handing everything to an investigator, actually wants — so it stays
  // available. It is simply no longer what you get by accident.
  out.push({ kind: "all", id: "all", label: "Everything this school holds (all years)", dated: true });
  return out;
}

export function ArchivePanel({
  initial,
  sessions,
}: {
  initial: Serialized<Archive>[];
  // NULL means the sessions read FAILED. Distinct from [], which means this
  // school genuinely has no calendar yet — the two need different words, because
  // "no sessions" sends a principal to build one they already have.
  sessions: Serialized<AcademicSessionDto>[] | null;
}) {
  // Dates follow the SCHOOL's calendar, not the browser's.
  const { shortDate } = useFormat();
  const [archives, setArchives] = useState<Serialized<Archive>[]>(initial);
  const scopes = sessions ? scopesOf(sessions) : [];
  // Default to the most recent DATED session — the archive somebody almost
  // always came here to take. Never to "everything": the whole-school export is
  // the expensive, most-sensitive one, and it should be chosen, not defaulted
  // into.
  const [scopeId, setScopeId] = useState<string>(
    () => scopes.find((sc) => sc.kind === "session" && sc.dated)?.id ?? "all",
  );
  const scope = scopes.find((sc) => sc.id === scopeId) ?? null;
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
    // The id is what BOUNDS the archive; the label is only how a human finds it
    // in ten years. Both come from the same picked option, so they cannot
    // disagree — which is the whole point of picking rather than typing.
    const body =
      scope === null || scope.kind === "all"
        ? { label: "All years" }
        : scope.kind === "term"
          ? { label: scope.label, termId: scope.id }
          : { label: scope.label, sessionId: scope.id };
    const res = await sendWithStepUp("POST", "privacy/archives", body);
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

      {sessions === null ? (
        <Alert variant="destructive" className="mb-3">
          <AlertTitle>The academic calendar could not be loaded</AlertTitle>
          <AlertDescription className="text-xs">
            An archive is taken OF a session or term, so this needs the calendar to know what it can cover.
            Reload before concluding this school has no sessions.
          </AlertDescription>
        </Alert>
      ) : sessions.length === 0 ? (
        <Alert variant="info" className="mb-3">
          <AlertTitle>This school has no academic sessions yet</AlertTitle>
          <AlertDescription className="text-xs">
            Set up the year on the{" "}
            <a href="/admin/calendar" className="underline">
              calendar
            </a>{" "}
            first. You can still take a whole-school export below, but it will not be bounded to a year.
          </AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={create} className="mb-3 flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <label htmlFor="arch-scope" className="text-xs font-medium">
            What to archive
          </label>
          {/* A PICKED session, not a typed one. The option carries the id that
              bounds the export, so the name on the file and its contents agree
              by construction — and no two archives of one year can end up under
              three different spellings. */}
          <select
            id="arch-scope"
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            className="h-8 w-72 rounded-md border border-input bg-background px-2 text-sm"
          >
            {scopes.map((sc) => (
              <option key={sc.id} value={sc.id} disabled={!sc.dated}>
                {sc.dated ? sc.label : `${sc.label} — needs start and end dates`}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" size="sm" className="h-8" disabled={busy === "create" || (scope !== null && !scope.dated)}>
          {busy === "create" ? "Archiving…" : "Take this archive"}
        </Button>
        <span className="text-xs text-muted-foreground">Large schools may take a minute.</span>
      </form>

      {scope?.kind === "all" && (
        <p className="mb-3 text-xs text-muted-foreground">
          This covers <strong>every year this school holds</strong>, not one session — the right choice for a school
          closing down or handing over its whole record, and much larger than a single year.
        </p>
      )}

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
                  {a.scope === null && <Badge variant="outline">all years</Badge>}
                </div>
                <span className="text-xs text-muted-foreground">
                  {/* WHAT IT COVERS, on the row. Without this a bounded archive
                      and a whole-school dump wearing one year's name read the
                      same, and every school holds some of each. */}
                  {a.scope
                    ? `${shortDate(a.scope.from)} – ${shortDate(a.scope.to)}`
                    : "all years — not bounded to a session"}{" "}
                  · {rows.toLocaleString()} records · taken {shortDate(a.createdAt)} ·{" "}
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
