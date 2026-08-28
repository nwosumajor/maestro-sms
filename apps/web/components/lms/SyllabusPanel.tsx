"use client";

// =============================================================================
// SyllabusPanel — the scheme of work for one subject, one term
// =============================================================================
// The LMS page listed content items with nothing saying what the term was meant
// to cover, so "are we on schedule?" was a question you answered by reading
// everything and remembering the plan.
//
// Design calls worth stating:
//
//   • THE PROGRESS BAR IS THE POINT. It sits at the top, before the editor,
//     because the question people open this for is "where are we", not "let me
//     retype the plan".
//   • Marking a week taught is ONE CLICK on the row, saved immediately. Putting
//     it behind the same Save as the text would mean a teacher who ticks week 6
//     on a Friday and closes the tab has recorded nothing.
//   • The text edit saves as a WHOLE DOCUMENT, because that is how a scheme of
//     work is edited — rows reordered, merged, renumbered. The server carries
//     the taught flags across by (week, topic) so an edit is not a reset.
// =============================================================================

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Item = {
  id: string;
  week: number;
  topic: string;
  objectives: string | null;
  resources: string | null;
  status: string;
  taughtAt: string | null;
};
type Syllabus = {
  id: string;
  overview: string | null;
  ownerId: string;
  items: Item[];
  progress: { taught: number; total: number; percent: number | null };
} | null;

// `id` is present for a row that already exists and absent for one the teacher
// has just added — which is exactly what tells the server to update rather than
// create, and what keeps a lesson's link to its topic alive across an edit.
type Draft = { id?: string; week: string; topic: string; objectives: string; resources: string };

export function SyllabusPanel({
  classId,
  subjectId,
  subjectName,
  termId,
  canWrite,
}: {
  classId: string;
  subjectId: string;
  subjectName: string;
  termId: string;
  canWrite: boolean;
}) {
  const [syl, setSyl] = React.useState<Syllabus>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [overview, setOverview] = React.useState("");
  const [rows, setRows] = React.useState<Draft[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const q = new URLSearchParams({ classId, subjectId, termId });
    const res = await fetch(`/api/sms/syllabus?${q}`);
    setLoaded(true);
    if (!res.ok) return;
    const j = (await res.json()) as Syllabus;
    setSyl(j);
    setOverview(j?.overview ?? "");
    setRows(
      (j?.items ?? []).map((i) => ({
        // The row's OWN identity, carried through the edit and echoed back on
        // save. Dropping it made the server match an edited plan to the old one
        // by CONTENTS, which lost a renamed week's taught mark and silently
        // unlinked every lesson filed against the plan.
        id: i.id,
        week: String(i.week),
        topic: i.topic,
        objectives: i.objectives ?? "",
        resources: i.resources ?? "",
      })),
    );
  }, [classId, subjectId, termId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setMsg(null);
    const items = rows
      .filter((r) => r.topic.trim())
      .map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        week: Number(r.week) || 1,
        topic: r.topic.trim(),
        objectives: r.objectives.trim() || null,
        resources: r.resources.trim() || null,
      }));
    const res = await fetch("/api/sms/syllabus", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ classId, subjectId, termId, overview: overview.trim() || null, items }),
    });
    if (res.ok) {
      setEditing(false);
      await load();
      setMsg("Saved.");
    } else {
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      setMsg(j.message ?? "Could not save the plan.");
    }
    setBusy(false);
  }

  // Saved on the spot rather than batched with the text: a teacher who ticks a
  // week and closes the tab has recorded it.
  async function toggle(item: Item) {
    const next = item.status === "TAUGHT" ? "PLANNED" : "TAUGHT";
    const res = await fetch(`/api/sms/syllabus/items/${item.id}/status`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (res.ok) await load();
  }

  const pct = syl?.progress.percent;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Scheme of work — {subjectName}</CardTitle>
            <CardDescription>
              What this subject covers this term, week by week. Tick a week once it has been taught.
            </CardDescription>
          </div>
          {canWrite && loaded && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {syl ? "Edit plan" : "Create plan"}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Progress first. The reason people open this is "where are we". */}
        {syl && syl.progress.total > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium tabular-nums">
                {syl.progress.taught} of {syl.progress.total} weeks taught
              </span>
              <span className="tabular-nums text-muted-foreground">{pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct ?? 0}%` }} />
            </div>
          </div>
        )}

        {!loaded ? (
          <p className="text-sm text-muted-foreground">Loading the plan…</p>
        ) : !syl && !editing ? (
          <p className="text-sm text-muted-foreground">
            No plan yet for this term.{" "}
            {canWrite ? "Create one so the term has an outline to work to." : "The subject teacher has not added one."}
          </p>
        ) : null}

        {syl?.overview && !editing && <p className="whitespace-pre-wrap text-sm">{syl.overview}</p>}

        {/* Read view — the working document. */}
        {!editing && syl && syl.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {syl.items.map((i) => (
                  <tr key={i.id} className="border-b border-border last:border-0 align-top">
                    <td className="w-16 py-2 pr-2 tabular-nums text-muted-foreground">Wk {i.week}</td>
                    <td className="py-2 pr-2">
                      <p className={i.status === "TAUGHT" ? "text-muted-foreground line-through" : "font-medium"}>{i.topic}</p>
                      {i.objectives && <p className="text-xs text-muted-foreground">{i.objectives}</p>}
                      {i.resources && <p className="text-xs text-muted-foreground">Resources: {i.resources}</p>}
                    </td>
                    <td className="w-28 py-2 text-right">
                      {canWrite ? (
                        <button
                          type="button"
                          onClick={() => void toggle(i)}
                          className={`rounded-md border px-2 py-1 text-xs ${
                            i.status === "TAUGHT" ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary"
                          }`}
                        >
                          {i.status === "TAUGHT" ? "✓ Taught" : "Mark taught"}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">{i.status === "TAUGHT" ? "Taught" : "Planned"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Edit view — the whole document at once. */}
        {editing && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="syl-overview">Aims for the term</Label>
              <textarea
                id="syl-overview"
                value={overview}
                onChange={(e) => setOverview(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-input bg-background p-2 text-sm"
                placeholder="What this term is meant to achieve."
              />
            </div>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex flex-wrap items-start gap-2 rounded-md border border-border p-2">
                  <Input
                    aria-label={`Week for row ${i + 1}`}
                    value={r.week}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, week: e.target.value } : x)))}
                    className="h-9 w-16"
                    inputMode="numeric"
                  />
                  <div className="min-w-[12rem] flex-1 space-y-1.5">
                    <Input
                      aria-label={`Topic for row ${i + 1}`}
                      value={r.topic}
                      onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, topic: e.target.value } : x)))}
                      placeholder="Topic"
                      className="h-9"
                    />
                    <Input
                      aria-label={`Objectives for row ${i + 1}`}
                      value={r.objectives}
                      onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, objectives: e.target.value } : x)))}
                      placeholder="Objectives (optional)"
                      className="h-9"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                    className="rounded px-1.5 text-xs text-muted-foreground hover:text-destructive"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setRows([...rows, { week: String(rows.length + 1), topic: "", objectives: "", resources: "" }])
                }
              >
                Add a week
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={busy}>
                {busy ? "Saving…" : "Save plan"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); void load(); }}>
                Cancel
              </Button>
              <span className="text-xs text-muted-foreground">
                Weeks already ticked stay ticked when you save — editing the plan is not a reset.
              </span>
            </div>
          </div>
        )}

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
