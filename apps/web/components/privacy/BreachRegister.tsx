"use client";

// =============================================================================
// BreachRegister — GDPR Art. 33/34, with the clock visible
// =============================================================================
// The form asks for the discovery time FIRST and defaults it to now, because that
// is what starts the 72-hour clock — and because a school recording a breach it
// found three days ago must be able to say so rather than quietly resetting the
// deadline by filling the form today.
// =============================================================================

import * as React from "react";
import { useFormat } from "@/components/shell/RegionProvider";
import { useRouter } from "next/navigation";
import type { BreachIncidentDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { readApiError } from "@/lib/api-error";

type Breach = Serialized<BreachIncidentDto>;

/** `datetime-local` wants YYYY-MM-DDTHH:mm with no zone. */
const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export function BreachRegister({ initial }: { initial: Breach[] }) {
  // Dates follow the SCHOOL's timezone, not the platform's.
  const { dateTime } = useFormat();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({
    title: "",
    description: "",
    discoveredAt: localNow(),
    riskLevel: "HIGH",
    affectedCount: 0,
    dataCategories: "",
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("report");
    setMsg(null);
    const res = await fetch("/api/sms/privacy/compliance/breaches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, discoveredAt: new Date(form.discoveredAt).toISOString() }),
    });
    setBusy(null);
    if (res.ok) {
      setOpen(false);
      setForm({ ...form, title: "", description: "", dataCategories: "", affectedCount: 0 });
      router.refresh();
    } else {
      setMsg(await readApiError(res));
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    const res = await fetch(`/api/sms/privacy/compliance/breaches/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(null);
    if (res.ok) router.refresh();
    else setMsg(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Breach register</CardTitle>
            <CardDescription>
              Every personal-data breach, and whether it was notified within 72 hours of the school
              becoming aware. Records are closed, never deleted.
            </CardDescription>
          </div>
          <Button size="sm" variant={open ? "outline" : "default"} onClick={() => setOpen(!open)}>
            {open ? "Cancel" : "Record a breach"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {open && (
          <form onSubmit={submit} className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap gap-3">
              <div className="min-w-56 flex-1 space-y-1.5">
                <Label htmlFor="b-title">What happened</Label>
                <Input id="b-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required placeholder="Staff laptop lost in transit" />
              </div>
              <div className="space-y-1.5">
                {/* First, and defaulted to now — this is what starts the clock. */}
                <Label htmlFor="b-when">When the school became aware</Label>
                <Input id="b-when" type="datetime-local" value={form.discoveredAt} onChange={(e) => setForm({ ...form, discoveredAt: e.target.value })} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="b-risk">Risk to the people</Label>
                <select id="b-risk" value={form.riskLevel} onChange={(e) => setForm({ ...form, riskLevel: e.target.value })} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="HIGH">High — they must be told</option>
                  <option value="LOW">Low</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="b-count">People affected</Label>
                <Input id="b-count" type="number" min={0} value={form.affectedCount} onChange={(e) => setForm({ ...form, affectedCount: Number(e.target.value) })} className="w-28" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-desc">Description</Label>
              <Input id="b-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required placeholder="What was exposed, how, and what has been done so far" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-cats">Categories of data</Label>
              <Input id="b-cats" value={form.dataCategories} onChange={(e) => setForm({ ...form, dataCategories: e.target.value })} placeholder="names, addresses, medical notes" />
            </div>
            <Button type="submit" size="sm" disabled={busy === "report"}>
              {busy === "report" ? "Recording…" : "Record"}
            </Button>
          </form>
        )}

        {initial.length === 0 ? (
          <p className="text-sm text-muted-foreground">No breaches recorded.</p>
        ) : (
          <ul className="space-y-3">
            {initial.map((b) => (
              <li key={b.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{b.title}</span>
                  <Badge variant={b.riskLevel === "HIGH" ? "destructive" : "outline"}>{b.riskLevel} risk</Badge>
                  <Badge variant="outline">{b.status.toLowerCase()}</Badge>
                  {b.overdue && <Badge variant="destructive">past the 72-hour deadline</Badge>}
                  {b.subjectsUnnotified && <Badge variant="destructive">people not told (Art. 34)</Badge>}
                  {b.affectedCount > 0 && <span className="text-xs text-muted-foreground">{b.affectedCount} affected</span>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Aware {dateTime(b.discoveredAt)} · notify by {dateTime(b.notifyDueAt)}
                  {b.status !== "CLOSED" && (
                    <>
                      {" · "}
                      {b.hoursRemaining >= 0
                        ? `${b.hoursRemaining}h left`
                        : `${Math.abs(b.hoursRemaining)}h overdue`}
                    </>
                  )}
                  {" · reported by "}
                  {b.reportedByName}
                </p>
                <p className="mt-1 text-muted-foreground">{b.description}</p>

                {b.status !== "CLOSED" && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {!b.notifiedAuthorityAt && (
                      <Button size="sm" variant="outline" disabled={busy === b.id} onClick={() => patch(b.id, { notifiedAuthorityAt: new Date().toISOString(), status: "NOTIFIED" })}>
                        Authority notified
                      </Button>
                    )}
                    {b.riskLevel === "HIGH" && !b.notifiedSubjectsAt && (
                      <Button size="sm" variant="outline" disabled={busy === b.id} onClick={() => patch(b.id, { notifiedSubjectsAt: new Date().toISOString() })}>
                        People told
                      </Button>
                    )}
                    <Button size="sm" variant="outline" disabled={busy === b.id} onClick={() => patch(b.id, { status: "CLOSED" })}>
                      Close
                    </Button>
                  </div>
                )}
                {b.noNotificationReason && (
                  <p className="mt-1 text-xs text-muted-foreground">Not notified because: {b.noNotificationReason}</p>
                )}
              </li>
            ))}
          </ul>
        )}

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
