"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { AppraisalDto, DisciplinaryCaseDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Appraisal = Serialized<AppraisalDto>;
type Case = Serialized<DisciplinaryCaseDto>;

const SEVERITY = ["LOW", "MEDIUM", "HIGH"] as const;

export function ReviewsPanel({
  userId,
  appraisals,
  cases,
  canAppraise,
  canDiscipline,
}: {
  userId: string;
  appraisals: Appraisal[];
  cases: Case[];
  canAppraise: boolean;
  canDiscipline: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const post = async (path: string, body: unknown, key: string) => {
    setBusy(key);
    const res = await fetch(`/api/sms/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(null);
    if (res.ok) router.refresh();
    return res.ok;
  };

  return (
    <>
      {canAppraise && <Appraisals userId={userId} appraisals={appraisals} post={post} busy={busy} />}
      {canDiscipline && <Disciplinary userId={userId} cases={cases} post={post} busy={busy} />}
    </>
  );
}

function Appraisals({ userId, appraisals, post, busy }: { userId: string; appraisals: Appraisal[]; post: (p: string, b: unknown, k: string) => Promise<boolean>; busy: string | null }) {
  const [period, setPeriod] = React.useState("");
  const [rating, setRating] = React.useState("");
  const [summary, setSummary] = React.useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!period) return;
    const ok = await post(`hr/staff/${userId}/appraisals`, { period, overallRating: rating ? parseInt(rating, 10) : null, summary: summary || null }, "app");
    if (ok) { setPeriod(""); setRating(""); setSummary(""); }
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Performance appraisals</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5"><Label htmlFor="ap-period">Period</Label><Input id="ap-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-H1" className="w-28" /></div>
          <div className="space-y-1.5"><Label htmlFor="ap-rating">Rating 1–5</Label><Input id="ap-rating" type="number" min={1} max={5} value={rating} onChange={(e) => setRating(e.target.value)} className="w-24" /></div>
          <div className="space-y-1.5 flex-1 min-w-40"><Label htmlFor="ap-sum">Summary</Label><Input id="ap-sum" value={summary} onChange={(e) => setSummary(e.target.value)} /></div>
          <Button type="submit" disabled={busy === "app"}>Add</Button>
        </form>
        {appraisals.length === 0 ? <p className="text-sm text-muted-foreground">No appraisals.</p> : (
          <ul className="space-y-1 text-sm">
            {appraisals.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span>{a.period}{a.overallRating != null ? ` · ${a.overallRating}/5` : ""}</span>
                <span className="flex items-center gap-2">
                  <Badge variant={a.status === "ACKNOWLEDGED" ? "default" : "secondary"}>{a.status}</Badge>
                  {a.status === "DRAFT" && <Button size="sm" variant="outline" disabled={busy === a.id} onClick={() => post(`hr/appraisals/${a.id}/submit`, {}, a.id)}>Submit</Button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Disciplinary({ userId, cases, post, busy }: { userId: string; cases: Case[]; post: (p: string, b: unknown, k: string) => Promise<boolean>; busy: string | null }) {
  const [title, setTitle] = React.useState("");
  const [severity, setSeverity] = React.useState<(typeof SEVERITY)[number]>("LOW");
  const open = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title) return;
    const ok = await post(`hr/staff/${userId}/disciplinary`, { title, severity }, "case");
    if (ok) setTitle("");
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Disciplinary case files</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={open} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5 flex-1 min-w-40"><Label htmlFor="dc-title">Open a case</Label><Input id="dc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Repeated lateness" /></div>
          <div className="space-y-1.5">
            <Label htmlFor="dc-sev">Severity</Label>
            <select id="dc-sev" value={severity} onChange={(e) => setSeverity(e.target.value as (typeof SEVERITY)[number])} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              {SEVERITY.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
            </select>
          </div>
          <Button type="submit" disabled={busy === "case"}>Open</Button>
        </form>
        {cases.length === 0 ? <p className="text-sm text-muted-foreground">No cases.</p> : cases.map((c) => (
          <div key={c.id} className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{c.title} <Badge variant={c.severity === "HIGH" ? "destructive" : "secondary"}>{c.severity}</Badge> <Badge variant="outline">{c.status}</Badge></span>
            </div>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {c.entries.map((e) => <li key={e.id}>· {e.note} <span className="text-xs">({e.createdAt.slice(0, 10)})</span></li>)}
            </ul>
            <CaseEntryForm caseId={c.id} post={post} busy={busy} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CaseEntryForm({ caseId, post, busy }: { caseId: string; post: (p: string, b: unknown, k: string) => Promise<boolean>; busy: string | null }) {
  const [note, setNote] = React.useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note) return;
    const ok = await post(`hr/disciplinary/${caseId}/entries`, { note }, `e-${caseId}`);
    if (ok) setNote("");
  };
  return (
    <form onSubmit={add} className="mt-2 flex gap-2">
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" className="h-8" />
      <Button type="submit" size="sm" variant="outline" disabled={busy === `e-${caseId}`}>Add note</Button>
    </form>
  );
}
