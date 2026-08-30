"use client";

// Behavioural and psychomotor ratings for one pupil, one term.
//
// Twenty traits in four groups, each 1–5. Entered by the class teacher beside
// the marks, printed on the report card beside them, and never averaged into
// them — "obedience 4" and "mathematics 81" are different kinds of statement
// about a child.
//
// The whole set saves in ONE act. Twenty separate saves would be twenty audit
// rows for one sitting, and a half-entered set on a report card reads as a
// judgement rather than an interruption.
//
// The scale is shown in the school's own words rather than as bare numbers: a
// parent cannot interpret "3", and a rating a family cannot interpret is how a
// parents' evening turns into an argument.

import type { Serialized, StudentTraitsDto } from "@sms/types";
import { TRAIT_GROUPS, TRAIT_KEYS, TRAIT_SCALE } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Traits = Serialized<StudentTraitsDto>;

export function TraitRatings({
  studentId,
  termId,
  termName,
  canEdit,
}: {
  studentId: string;
  termId: string | null;
  termName?: string | null;
  /**
   * grade.write — held by every subject teacher, not only the class teacher.
   *
   * The ratings are the CLASS TEACHER's to record, and supervision is per-pupil
   * so a session cannot answer it. This is the role half; `mayWrite` on the DTO
   * below is the other half, and the grid needs both.
   */
  canEdit: boolean;
}) {
  const [scores, setScores] = React.useState<Record<string, number>>({});
  const [meta, setMeta] = React.useState<{ by: string | null; at: string | null }>({ by: null, at: null });
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [mayWrite, setMayWrite] = React.useState(false);

  React.useEffect(() => {
    if (!termId) return;
    void (async () => {
      const res = await fetch(`/api/sms/reportcards/${studentId}/traits?termId=${termId}`, { cache: "no-store" });
      setLoaded(true);
      if (!res.ok) return;
      const d = (await res.json()) as Traits;
      setScores(Object.fromEntries(d.ratings.map((r) => [r.traitKey, r.score])));
      setMeta({ by: d.ratedByName, at: d.ratedAt ? String(d.ratedAt).slice(0, 10) : null });
      setMayWrite(d.mayWrite);
    })();
  }, [studentId, termId]);

  if (!termId) return null;
  // BOTH halves. Until the read lands `mayWrite` is false, so the grid renders
  // read-only for a moment rather than offering a control it may withdraw.
  const editable = canEdit && mayWrite;
  const rated = Object.keys(scores).length;
  // Nothing recorded and no right to record it: a family sees the section only
  // when there is something in it.
  if (!canEdit && loaded && rated === 0) return null;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/sms/reportcards/${studentId}/traits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        termId,
        ratings: Object.entries(scores).map(([traitKey, score]) => ({ traitKey, score })),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setMsg(await readApiError(res));
      return;
    }
    const d = (await res.json()) as Traits;
    setMeta({ by: d.ratedByName, at: d.ratedAt ? String(d.ratedAt).slice(0, 10) : null });
    setMsg(`Saved ${d.ratings.length} of ${TRAIT_KEYS.length}.`);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Skills and behaviour{termName ? ` — ${termName}` : ""}</CardTitle>
        <CardDescription>
          Rated 1–5 by the class teacher. These print on the report card beside the marks and are never added into
          them.
          {meta.by ? ` Last recorded by ${meta.by}${meta.at ? ` on ${meta.at}` : ""}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {TRAIT_GROUPS.map((group) => (
            <div key={group.key} className="space-y-1">
              <p className="text-sm font-medium">{group.label}</p>
              {group.traits.map((t) => (
                <div key={t.key} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">{t.label}</span>
                  {editable ? (
                    <select
                      aria-label={t.label}
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                      value={scores[t.key] ?? ""}
                      onChange={(e) =>
                        setScores((prev) => {
                          const next = { ...prev };
                          if (e.target.value === "") delete next[t.key];
                          else next[t.key] = Number(e.target.value);
                          return next;
                        })
                      }
                    >
                      <option value="">—</option>
                      {TRAIT_SCALE.map((r) => (
                        <option key={r.score} value={r.score}>
                          {r.score}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-sm font-medium">{scores[t.key] ?? "—"}</span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* The key, in the school's words. Printed on the report card too. */}
        <div className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
          {TRAIT_SCALE.map((r) => (
            <div key={r.score}>
              <span className="font-medium text-foreground">{r.score}</span> — {r.label}
            </div>
          ))}
        </div>

        {editable && (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy || rated === 0} onClick={() => void save()}>
              Save {rated} rating{rated === 1 ? "" : "s"}
            </Button>
            {rated > 0 && rated < TRAIT_KEYS.length && (
              // Said plainly rather than blocked: a teacher may deliberately
              // leave a trait unrated, but should know the report card will show
              // it blank.
              <span className="text-xs text-muted-foreground">
                {TRAIT_KEYS.length - rated} left blank — they will print blank.
              </span>
            )}
          </div>
        )}
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
