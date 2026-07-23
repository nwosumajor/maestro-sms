"use client";

import type {
  ClassDto,
  ClassEligibilityDto,
  PromotionBatchDto,
  PromotionOutcome,
  Serialized,
} from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Cls = Serialized<ClassDto>;
type Batch = Serialized<PromotionBatchDto>;
type Eligibility = Serialized<ClassEligibilityDto>;

export function PromotionManager({
  classes,
  batches,
  currentUserId,
  canApprove,
}: {
  classes: Cls[];
  batches: Batch[];
  currentUserId: string;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [sourceClassId, setSourceClassId] = React.useState(classes[0]?.id ?? "");
  const [eligibility, setEligibility] = React.useState<Eligibility[] | null>(null);
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  // Per-student overrides, keyed by studentId. Absent = PROMOTE (the default),
  // so "one click" still promotes the whole class untouched.
  const [outcomes, setOutcomes] = React.useState<Record<string, { outcome: PromotionOutcome; targetClassId?: string; note?: string }>>({});

  const loadEligibility = async () => {
    setEligibility(null);
    setOutcomes({});
    const res = await fetch(`/api/sms/classes/${sourceClassId}/eligibility`);
    if (res.ok) setEligibility((await res.json()) as Eligibility[]);
    else setMsg(`Could not load eligibility (${res.status}).`);
  };

  const source = classes.find((c) => c.id === sourceClassId);
  const target = source?.nextClassId ? classes.find((c) => c.id === source.nextClassId) : null;
  // Any class other than the source and the promotion target can receive a demotion.
  const demoteChoices = classes.filter((c) => c.id !== sourceClassId && c.id !== target?.id);

  const setOutcome = (studentId: string, outcome: PromotionOutcome) =>
    setOutcomes((o) => {
      if (outcome === "PROMOTE") { const { [studentId]: _drop, ...rest } = o; return rest; }
      return { ...o, [studentId]: { ...o[studentId], outcome, targetClassId: outcome === "DEMOTE" ? (o[studentId]?.targetClassId ?? demoteChoices[0]?.id) : undefined } };
    });

  const overrides = Object.entries(outcomes);
  const retainN = overrides.filter(([, v]) => v.outcome === "RETAIN").length;
  const demoteN = overrides.filter(([, v]) => v.outcome === "DEMOTE").length;

  const stage = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    // Only the overrides travel; the server fills PROMOTE for everyone else.
    const decisions = overrides.map(([studentId, v]) => ({ studentId, outcome: v.outcome, targetClassId: v.targetClassId ?? null, note: v.note ?? null }));
    const res = await fetch("/api/sms/promotions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceClassId, ...(decisions.length ? { decisions } : {}) }),
    });
    setBusy(false);
    if (res.ok) {
      const b = (await res.json()) as Batch;
      setMsg(
        `Staged from ${b.sourceClassName}: ${b.promoteCount} promoted → ${b.targetClassName ?? "graduation"}` +
          `${b.retainCount ? `, ${b.retainCount} retained` : ""}${b.demoteCount ? `, ${b.demoteCount} demoted` : ""}. Awaiting school-admin approval.`,
      );
      setOutcomes({});
      router.refresh();
    } else setMsg(res.status === 400 ? "Nothing to promote (no active students or no target)." : await readApiError(res));
  };

  const decide = async (id: string, action: "approve" | "reject") => {
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/sms/promotions/${id}/${action}`, { method: "POST" });
    setBusy(false);
    if (res.ok) { setMsg(action === "approve" ? "Promotion approved — enrollments moved." : "Promotion rejected."); router.refresh(); }
    else setMsg(res.status === 403 ? "A different person (not the initiator) must approve." : await readApiError(res));
  };

  const pending = batches.filter((b) => b.status === "PENDING");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">End-of-session promotion</CardTitle>
        <CardDescription>
          Promote a class&apos;s students into its next class. Staging moves nothing — a school admin (a different
          person) approves before any enrollment changes. Classes with no next class graduate their students.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={stage} className="flex flex-wrap items-end gap-2">
          <select aria-label="Source class" value={sourceClassId} onChange={(e) => setSourceClassId(e.target.value)} className={sel}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <span className="text-sm text-muted-foreground">
            → {target ? target.name : source?.nextClassId ? "(next class)" : "graduation"}
          </span>
          <Button type="submit" size="sm" disabled={busy || !sourceClassId}>Stage promotion</Button>
          <Button type="button" size="sm" variant="ghost" onClick={loadEligibility}>Eligibility signal</Button>
        </form>

        {eligibility && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">
              Averages and attendance are <strong>signals</strong> to inform you — the system never decides. Everyone
              is promoted by default; set anyone who performed poorly to <strong>Retain</strong> (repeat this class) or{" "}
              <strong>Demote</strong> (move down to a chosen class).
            </p>
            {eligibility.length === 0 && <p className="text-sm text-muted-foreground">No active students.</p>}
            {eligibility.map((s) => {
              const o = outcomes[s.studentId]?.outcome ?? "PROMOTE";
              return (
                <div key={s.studentId} className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-2 last:border-0 last:pb-0">
                  <span className="min-w-40 flex-1 text-sm">{s.name}</span>
                  <span className="text-xs text-muted-foreground">
                    avg {s.averageScore ?? "—"}% · attendance {s.attendancePercent ?? "—"}%
                  </span>
                  <div className="flex gap-1">
                    {(["PROMOTE", "RETAIN", "DEMOTE"] as const).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        aria-pressed={o === opt}
                        disabled={opt === "DEMOTE" && demoteChoices.length === 0}
                        onClick={() => setOutcome(s.studentId, opt)}
                        className={
                          "rounded px-2 py-1 text-xs font-medium transition-colors " +
                          (o === opt ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent") +
                          (opt === "DEMOTE" && demoteChoices.length === 0 ? " cursor-not-allowed opacity-50" : "")
                        }
                      >
                        {opt[0] + opt.slice(1).toLowerCase()}
                      </button>
                    ))}
                  </div>
                  {o === "DEMOTE" && (
                    <select
                      aria-label={`Demotion class for ${s.name}`}
                      value={outcomes[s.studentId]?.targetClassId ?? ""}
                      onChange={(ev) => setOutcomes((x) => ({ ...x, [s.studentId]: { ...x[s.studentId], outcome: "DEMOTE", targetClassId: ev.target.value } }))}
                      className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                    >
                      {demoteChoices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
            {(retainN > 0 || demoteN > 0) && (
              <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
                {retainN > 0 && `${retainN} to retain`}
                {retainN > 0 && demoteN > 0 && " · "}
                {demoteN > 0 && `${demoteN} to demote`}
                {" — these ride the same approval; a school admin reviews before anything moves."}
              </p>
            )}
          </div>
        )}

        {msg && <p className="rounded-md bg-muted px-3 py-2 text-sm">{msg}</p>}

        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-sm font-medium text-muted-foreground">Promotion batches ({pending.length} pending)</p>
          {batches.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
          {batches.map((b) => {
            const mine = b.initiatedById === currentUserId;
            return (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">
                    {b.sourceClassName} → {b.targetClassName ?? "graduation"} · {b.studentCount} students{" "}
                    <Badge variant={b.status === "APPROVED" ? "secondary" : b.status === "REJECTED" ? "destructive" : "outline"}>
                      {b.status.toLowerCase()}
                    </Badge>
                    {mine && <span className="ml-2 text-xs text-muted-foreground">(initiated by you)</span>}
                  </p>
                  {/* What the approver is actually agreeing to. */}
                  <p className="text-xs text-muted-foreground">
                    {b.promoteCount} promoted
                    {b.retainCount > 0 && ` · ${b.retainCount} retained`}
                    {b.demoteCount > 0 && ` · ${b.demoteCount} demoted`}
                  </p>
                  {b.decisions.filter((d) => d.outcome !== "PROMOTE").length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-amber-800">
                      {b.decisions
                        .filter((d) => d.outcome !== "PROMOTE")
                        .map((d) => (
                          <li key={d.studentId}>
                            {d.outcome === "RETAIN"
                              ? `Retain in ${b.sourceClassName}`
                              : `Demote to ${d.targetClassName ?? "another class"}`}
                            {d.note ? ` — ${d.note}` : ""}
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
                {b.status === "PENDING" && canApprove && (
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" className="h-7" disabled={busy || mine} onClick={() => decide(b.id, "approve")}>Approve</Button>
                    <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => decide(b.id, "reject")}>Reject</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
