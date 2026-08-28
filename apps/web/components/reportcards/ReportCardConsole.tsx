"use client";

import * as React from "react";
import type { AcademicSessionDto, ClassBroadsheetDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { downloadReportCard } from "@/lib/report-card-download";

type ClassOption = { id: string; name: string };
type Sheet = Serialized<ClassBroadsheetDto>;

/**
 * Print report cards for a CLASS and a TERM.
 *
 * The capability already existed and had no front door: a card for a past term
 * could only be produced by finding the pupil, opening their page, scrolling to
 * a panel called "Remarks" and changing a term selector there. Nobody looks
 * under Remarks to print a report card, and nothing let you do a whole class.
 *
 * The roster comes from the BROADSHEET rather than the class roll, deliberately:
 * it lists whoever has results for that class and term, so a pupil who has since
 * moved class or left still appears on the term they were actually taught in.
 * Asking the live roll instead would silently omit exactly the pupils whose
 * records are most often chased.
 */
export function ReportCardConsole({
  classes,
  sessions,
}: {
  classes: ClassOption[];
  sessions: Serialized<AcademicSessionDto>[];
}) {
  const terms = React.useMemo(
    () => sessions.flatMap((s) => s.terms.map((t) => ({ ...t, sessionName: s.name }))),
    [sessions],
  );
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [termId, setTermId] = React.useState(terms.find((t) => t.isCurrent)?.id ?? terms[0]?.id ?? "");
  const [sheet, setSheet] = React.useState<Sheet | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!classId || !termId) return;
    setLoading(true);
    setFailed(false);
    const res = await fetch(`/api/sms/term-results/broadsheet?classId=${classId}&termId=${termId}`, {
      cache: "no-store",
    });
    setLoading(false);
    // A failed read is NOT an empty class: "no pupils" would send somebody away
    // believing there is nothing to print.
    if (!res.ok) {
      setSheet(null);
      setFailed(true);
      return;
    }
    setSheet((await res.json()) as Sheet);
  }, [classId, termId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const rows = sheet?.rows ?? [];
  // Only a pupil with marks has a card worth printing. The others are listed
  // and named rather than hidden, so a head of year can see WHY the count is
  // short before they print.
  const printable = rows.filter((r) => r.average !== null);
  const unmarked = rows.filter((r) => r.average === null);

  const printOne = async (studentId: string, name: string) => {
    setBusy(studentId);
    setMsg(null);
    const r = await downloadReportCard(studentId, termId);
    setBusy(null);
    setMsg(r.ok ? `Saved ${r.filename}` : `${name}: ${r.error}`);
  };

  const printAll = async () => {
    setBusy("all");
    setMsg(null);
    let done = 0;
    const failures: string[] = [];
    // SEQUENTIAL, on purpose. Each card renders a PDF and writes a Document
    // Vault copy that notifies the guardians; firing thirty at once would put
    // thirty renders and thirty notification fan-outs on the server at the same
    // moment for one click.
    for (const r of printable) {
      const out = await downloadReportCard(r.studentId, termId);
      if (out.ok) done += 1;
      else failures.push(r.studentName);
    }
    setBusy(null);
    // Report what did NOT happen, not just the count that did.
    setMsg(
      failures.length === 0
        ? `Printed ${done} report card${done === 1 ? "" : "s"}.`
        : `Printed ${done}; ${failures.length} failed: ${failures.slice(0, 3).join(", ")}${failures.length > 3 ? "…" : ""}`,
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Print report cards</CardTitle>
        <CardDescription>
          Pick a class and a term. Any term of any session can be printed, including one that has ended — a card is
          rendered from the marks PUBLISHED for that term, so it does not change if a pupil later moves class.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="rc-class">Class</Label>
            <select
              id="rc-class"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rc-term">Term</Label>
            <select
              id="rc-term"
              value={termId}
              onChange={(e) => setTermId(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.sessionName} · {t.name}{t.isCurrent ? " (current)" : ""}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={printAll} disabled={busy !== null || printable.length === 0}>
            {busy === "all" ? "Printing…" : `Print all (${printable.length})`}
          </Button>
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : failed ? (
          <p className="text-sm text-destructive">
            The class list could not be loaded, so this is <strong>not</strong> a report that nobody has marks. Reload
            and try again.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pupils on this class for that term.</p>
        ) : (
          <>
            <ul className="divide-y divide-border/70">
              {printable.map((r) => (
                <li key={r.studentId} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="text-sm">
                    {r.studentName}
                    {r.admissionNumber ? (
                      <span className="ml-2 text-xs text-muted-foreground">{r.admissionNumber}</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground tnum">
                      avg {r.average}
                      {r.position !== null ? ` · position ${r.position}` : ""}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      aria-label={`Print report card for ${r.studentName}`}
                      onClick={() => printOne(r.studentId, r.studentName)}
                    >
                      {busy === r.studentId ? "Printing…" : "Print"}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            {unmarked.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {unmarked.length} pupil{unmarked.length === 1 ? " has" : "s have"} no published marks for this term and
                {unmarked.length === 1 ? " is" : " are"} not listed:{" "}
                {unmarked.slice(0, 5).map((r) => r.studentName).join(", ")}
                {unmarked.length > 5 ? `, and ${unmarked.length - 5} more` : ""}.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
