"use client";

// Who still needs rating — the class-level view behind the per-pupil card.
//
// A teacher rates a class of thirty in one sitting, and the thing they need
// first is not a six-hundred-cell grid: it is the answer to "who have I not done
// yet". This shows exactly that — a row per pupil, how many of the twenty traits
// are recorded, and a link straight to the pupil.
//
// One request paints it. Thirty separate reads would make the page slow at
// exactly the moment it is being used.

import type { Serialized, IdNameDto } from "@sms/types";
import { TRAIT_KEYS } from "@sms/types";
import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Named = Serialized<IdNameDto>;
type Session = { id: string; name: string; terms: Array<{ id: string; name: string; isCurrent?: boolean }> };
type Row = { studentId: string; studentName: string; ratings: Array<{ traitKey: string; score: number }> };

const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

export function TraitProgress({ classes, sessions }: { classes: Named[]; sessions: Session[] }) {
  const allTerms = sessions.flatMap((s) => s.terms.map((t) => ({ ...t, sessionName: s.name })));
  const defaultTerm = allTerms.find((t) => t.isCurrent) ?? allTerms[0];
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [termId, setTermId] = React.useState(defaultTerm?.id ?? "");
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!classId || !termId) return;
    setMsg(null);
    const res = await fetch(`/api/sms/reportcards/classes/${classId}/traits?termId=${termId}`, { cache: "no-store" });
    if (!res.ok) {
      setRows([]);
      setMsg(res.status === 404 ? "You don't teach this class." : `Couldn't load (${res.status}).`);
      return;
    }
    setRows((await res.json()) as Row[]);
  }, [classId, termId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (classes.length === 0) return null;
  const total = TRAIT_KEYS.length;
  const done = (rows ?? []).filter((r) => r.ratings.length === total).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Skills and behaviour — who still needs rating</CardTitle>
        <CardDescription>
          Twenty traits per pupil, entered on their own page. This is the list of who is done.
          {rows && rows.length > 0 ? ` ${done} of ${rows.length} complete.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <select aria-label="Class" value={classId} onChange={(e) => setClassId(e.target.value)} className={sel}>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select aria-label="Term" value={termId} onChange={(e) => setTermId(e.target.value)} className={sel}>
            {allTerms.length === 0 && <option value="">No terms defined</option>}
            {allTerms.map((t) => (
              <option key={t.id} value={t.id}>{t.sessionName} · {t.name}</option>
            ))}
          </select>
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        {rows && rows.length === 0 && !msg && <p className="text-sm text-muted-foreground">No pupils in this class.</p>}

        {rows && rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Pupil</th>
                <th className="py-1 pr-3 font-medium">Rated</th>
                <th className="py-1 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const n = r.ratings.length;
                return (
                  <tr key={r.studentId} className="border-b border-border/50 last:border-0">
                    <td className="py-1 pr-3">{r.studentName}</td>
                    <td className="py-1 pr-3">
                      {/* The number, not a tick: "17 of 20" tells a teacher there
                          is something left, which a green tick would hide. */}
                      <span className={n === total ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
                        {n} of {total}
                      </span>
                    </td>
                    <td className="py-1">
                      <Link className="text-xs underline underline-offset-2" href={`/students/${r.studentId}`}>
                        {n === 0 ? "Rate" : "Review"}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
