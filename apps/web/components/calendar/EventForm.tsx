"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MEETING_PROVIDERS, MEETING_PROVIDER_LABELS } from "@sms/types";
import { readApiError } from "@/lib/api-error";

export function EventForm() {
  const router = useRouter();
  const [title, setTitle] = React.useState("");
  const [startsAt, setStartsAt] = React.useState("");
  const [audience, setAudience] = React.useState<"ALL" | "STAFF">("ALL");
  // Optional video meeting — this is what makes a STAFF-audience event usable as
  // an actual staff meeting. The server validates the URL's host and only
  // releases it inside the join window.
  const [provider, setProvider] = React.useState("");
  const [joinUrl, setJoinUrl] = React.useState("");
  // AN ALL-DAY EVENT, AND ONE THAT ENDS.
  //
  // The form's own placeholder said "e.g. Mid-term break" — a multi-day,
  // all-day event it could not create. `endsAt` and `allDay` have been on the
  // schema since the module shipped and no screen sent either, so every entry
  // was a single instant and a school could not put a holiday on its calendar.
  const [allDay, setAllDay] = React.useState(false);
  const [endsAt, setEndsAt] = React.useState("");
  // AND ONE THAT REPEATS. The expansion engine (`@sms/types/recurrence.ts`) has
  // DAILY / WEEKLY / MONTHLY, per-weekday selection and an end date, is unit
  // tested, and was reachable from nothing.
  const [recurrence, setRecurrence] = React.useState("NONE");
  const [recurrenceUntil, setRecurrenceUntil] = React.useState("");
  const [recurrenceDays, setRecurrenceDays] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const toggleDay = (d: string) =>
    setRecurrenceDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !startsAt) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/sms/events", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        // An ALL-DAY event is a whole day, so it starts at midnight and ends at
        // the end of its last day. A `datetime-local` cannot express that, so
        // the date inputs are plain dates and the times are supplied here —
        // otherwise "Mid-term break" would begin at whatever o'clock somebody
        // happened to pick.
        startsAt: allDay ? new Date(`${startsAt}T00:00:00`).toISOString() : new Date(startsAt).toISOString(),
        ...(endsAt
          ? { endsAt: allDay ? new Date(`${endsAt}T23:59:59`).toISOString() : new Date(endsAt).toISOString() }
          : {}),
        allDay,
        audience,
        ...(recurrence !== "NONE"
          ? {
              recurrence,
              // Only WEEKLY uses the day list; sending it otherwise would be a
              // value the engine ignores and a reader has to explain.
              ...(recurrence === "WEEKLY" && recurrenceDays.length > 0 ? { recurrenceDays } : {}),
              // An end date is OPTIONAL and the engine bounds every read by its
              // own window either way — but without one a weekly assembly
              // entered for one term is still on the calendar years later.
              ...(recurrenceUntil ? { recurrenceUntil: new Date(`${recurrenceUntil}T23:59:59`).toISOString() } : {}),
            }
          : {}),
        provider: provider || undefined,
        joinUrl: provider ? joinUrl : undefined,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setTitle("");
      setStartsAt("");
      setEndsAt("");
      setAllDay(false);
      setRecurrence("NONE");
      setRecurrenceUntil("");
      setRecurrenceDays([]);
      setProvider("");
      setJoinUrl("");
      router.refresh();
    }
    else setErr(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Add an event</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1.5"><Label htmlFor="ev-title">Title</Label><Input id="ev-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Mid-term break" /></div>
          <label className="flex items-center gap-1.5 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => {
                // The two inputs take different VALUE formats, so a stale value
                // from the other mode is not a date the browser will accept.
                setAllDay(e.target.checked);
                setStartsAt("");
                setEndsAt("");
              }}
            />
            All day
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="ev-when">{allDay ? "First day" : "When"}</Label>
            <Input
              id="ev-when"
              type={allDay ? "date" : "datetime-local"}
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-end">{allDay ? "Last day" : "Ends"} <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input
              id="ev-end"
              type={allDay ? "date" : "datetime-local"}
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-rec">Repeats</Label>
            <select
              id="ev-rec"
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="NONE">Does not repeat</option>
              <option value="DAILY">Every day</option>
              <option value="WEEKLY">Every week</option>
              <option value="MONTHLY">Every month</option>
            </select>
          </div>
          {recurrence === "WEEKLY" && (
            <div className="space-y-1.5">
              <Label>On these days <span className="font-normal text-muted-foreground">(defaults to the start day)</span></Label>
              <div className="flex gap-1">
                {(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-label={`Repeat on ${d}`}
                    aria-pressed={recurrenceDays.includes(d)}
                    onClick={() => toggleDay(d)}
                    className={`h-9 w-10 rounded-md border text-xs ${
                      recurrenceDays.includes(d)
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-input bg-background text-muted-foreground"
                    }`}
                  >
                    {d[0] + d.slice(1, 2).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
          )}
          {recurrence !== "NONE" && (
            <div className="space-y-1.5">
              <Label htmlFor="ev-until">Until <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input id="ev-until" type="date" value={recurrenceUntil} onChange={(e) => setRecurrenceUntil(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                Leave it blank and it repeats indefinitely — fine for an assembly, wrong for something
                that ends with the term.
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ev-aud">Audience</Label>
            <select id="ev-aud" value={audience} onChange={(e) => setAudience(e.target.value as "ALL" | "STAFF")} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="ALL">Everyone</option>
              <option value="STAFF">Staff only</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-prov">Meeting</Label>
            <select id="ev-prov" value={provider} onChange={(e) => setProvider(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">In person</option>
              {MEETING_PROVIDERS.map((mp) => <option key={mp} value={mp}>{MEETING_PROVIDER_LABELS[mp]}</option>)}
            </select>
          </div>
          {provider && (
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="ev-url">Join link</Label>
              <Input id="ev-url" value={joinUrl} onChange={(e) => setJoinUrl(e.target.value)} placeholder="https://teams.microsoft.com/l/meetup-join/…" required />
            </div>
          )}
          <Button type="submit" disabled={busy}>Add</Button>
          {err && <p className="w-full text-sm text-destructive">{err}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
