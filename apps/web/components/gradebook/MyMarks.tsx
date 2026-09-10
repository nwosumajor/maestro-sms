"use client";

// A pupil's (or a parent's children's) marks, assessment by assessment.
//
// The report card shows a term-WEIGHTED total; this is the detail behind it.
// /grades/mine was built, relationship-scoped and permission-gated — and no page
// ever fetched it, so a student could see their grade but never the marks that
// produced it.
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Mark = {
  id: string;
  score: number | null;
  maxScore?: number | null;
  assessmentTitle?: string | null;
  subjectName?: string | null;
  studentName?: string | null;
  gradedAt?: string | null;
};

type Page = {
  items: Mark[];
  total: number;
  page: number;
  pageSize: number;
  termId: string | null;
  termName: string | null;
  terms: Array<{ id: string; name: string }>;
};

export function MyMarks() {
  // ONE TERM, AND IT SAYS WHICH.
  //
  // This card was headed "Marks so far" with an empty state reading "Nothing
  // has been marked yet this term", over a list that was every mark the pupil
  // had ever been given. A pupil three years in was shown three years of work
  // under a heading about this term and could not tell which was which — and
  // the fetch behind it grew with their time at the school: measured at 810
  // marks / 277 KB for a pupil, 2,430 / 831 KB for a parent of three.
  //
  // The term is now real and the others are still reachable, which is what
  // separates bounding a read from hiding a record.
  const [data, setData] = useState<Page | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  // A FAILED read is not an empty one. `res.ok ? json : []` rendered "Nothing
  // has been marked yet this term" — a statement about this pupil's academic
  // record — whenever the request itself failed. A student or parent reading
  // that has no way to tell it apart from the truth, and no reason to retry.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const qs = new URLSearchParams();
        if (termId) qs.set("termId", termId);
        if (page > 1) qs.set("page", String(page));
        const r = await fetch(`/api/sms/grades/mine${qs.toString() ? `?${qs}` : ""}`);
        if (!live) return;
        if (r.ok) {
          setFailed(false);
          setData((await r.json()) as Page);
        } else setFailed(true);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [termId, page]);

  if (failed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Marks so far</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Couldn&rsquo;t load your marks just now. Reload the page to try again — this does not
            mean nothing has been marked.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Nothing marked yet is the normal state early in a term — say so rather than
  // rendering an empty box that looks broken.
  if (data === null) return null;
  const rows = data.items;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Marks{data.termName ? ` — ${data.termName}` : ""}
        </CardTitle>
        <CardDescription>
          Individual pieces of work. The report card totals these using the school&rsquo;s weighting.
        </CardDescription>
        {data.terms.length > 1 && (
          <div className="pt-2">
            <label htmlFor="marks-term" className="sr-only">
              Term
            </label>
            {/* Earlier terms stay reachable. Bounding the read to one term is
                only honest if the rest are still somewhere. */}
            <select
              id="marks-term"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={data.termId ?? ""}
              onChange={(e) => {
                setPage(1);
                setTermId(e.target.value);
              }}
            >
              {data.terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing has been marked in {data.termName ?? "this term"} yet
            {data.terms.length > 1 ? " — earlier terms are in the list above." : "."}
          </p>
        ) : (
          <ul className="divide-y divide-border/70">
            {rows.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <span className="min-w-0">
                  <span className="truncate">{m.assessmentTitle ?? "Assessment"}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[m.studentName, m.subjectName].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="font-medium tabular-nums">
                  {m.score ?? "—"}
                  {m.maxScore ? <span className="text-muted-foreground"> / {m.maxScore}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* WHAT IS SHOWN OUT OF WHAT THERE IS. A page that does not say it is a
            page reads as the whole record. */}
        {data.total > 0 && (
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {(data.page - 1) * data.pageSize + 1}–
              {Math.min(data.page * data.pageSize, data.total)} of {data.total}
            </span>
            {pages > 1 && (
              <span className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={data.page <= 1}
                  onClick={() => setPage((n) => Math.max(1, n - 1))}
                  className="underline underline-offset-2 disabled:no-underline disabled:opacity-40"
                >
                  Previous
                </button>
                <span>
                  Page {data.page} of {pages}
                </span>
                <button
                  type="button"
                  disabled={data.page >= pages}
                  onClick={() => setPage((n) => n + 1)}
                  className="underline underline-offset-2 disabled:no-underline disabled:opacity-40"
                >
                  Next
                </button>
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
