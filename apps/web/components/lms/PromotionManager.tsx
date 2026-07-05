"use client";

import type { ClassDto, ClassEligibilityDto, PromotionBatchDto, Serialized } from "@sms/types";
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

  const loadEligibility = async () => {
    setEligibility(null);
    const res = await fetch(`/api/sms/classes/${sourceClassId}/eligibility`);
    if (res.ok) setEligibility((await res.json()) as Eligibility[]);
    else setMsg(`Could not load eligibility (${res.status}).`);
  };

  const source = classes.find((c) => c.id === sourceClassId);
  const target = source?.nextClassId ? classes.find((c) => c.id === source.nextClassId) : null;

  const stage = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/promotions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceClassId }),
    });
    setBusy(false);
    if (res.ok) {
      const b = (await res.json()) as Batch;
      setMsg(`Staged promotion of ${b.studentCount} students from ${b.sourceClassName} → ${b.targetClassName ?? "graduation"}. Awaiting school-admin approval.`);
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
          <div className="space-y-1 rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">
              Read-only signal — averages + attendance for the source class. Promotion stays a human decision.
            </p>
            {eligibility.length === 0 && <p className="text-sm text-muted-foreground">No active students.</p>}
            {eligibility.map((s) => (
              <div key={s.studentId} className="flex items-center justify-between text-sm">
                <span>{s.name}</span>
                <span className="text-muted-foreground">
                  avg {s.averageScore ?? "—"}% · attendance {s.attendancePercent ?? "—"}%
                </span>
              </div>
            ))}
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
