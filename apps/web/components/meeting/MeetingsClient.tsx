"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { MeetingSlotDto, MeetingBookingDto, Serialized } from "@sms/types";
import { MEETING_PROVIDERS, MEETING_PROVIDER_LABELS } from "@sms/types";
import { JoinMeetingLink } from "@/components/meeting/JoinMeetingLink";
import { sendSms, postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dateTime } from "@/lib/format";

type Slot = Serialized<MeetingSlotDto>;
type Booking = Serialized<MeetingBookingDto>;

// Parent-teacher meetings. Hosts (teachers/staff) open slots and see bookings;
// parents browse open slots and book one for a child. The two panels render by
// what the caller can do.
/** What this host may address. Built server-side from their own classes, so the
 *  dropdown can never offer a scope the server would refuse. */
export type AudienceChoice = { kind: string; ref: string | null; label: string };

export function MeetingsClient({
  canHost,
  canBook,
  mySlots,
  openSlots,
  myBookings,
  children,
  audiences = [],
}: {
  canHost: boolean;
  canBook: boolean;
  mySlots: Slot[];
  openSlots: Slot[];
  myBookings: Booking[];
  children: { studentId: string; studentName: string }[];
  /** Audience options for the host form, from the server. Empty = whole-school
   *  only, which is what every slot was before this existed. */
  audiences?: AudienceChoice[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ date: "", start: "09:00", end: "09:30", location: "", note: "", provider: "", joinUrl: "" });
  const [childBy, setChildBy] = React.useState<Record<string, string>>({});

  const run = async (fn: () => Promise<{ ok: boolean; error?: string | null }>, ok: string) => {
    setBusy(true);
    setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) {
      setMsg(ok);
      router.refresh();
    } else setMsg(res.error ?? "Failed.");
  };

  // Index 0 is always the safest scope the server offered this host.
  const [audienceIdx, setAudienceIdx] = React.useState(0);
  const picked = audiences[audienceIdx];

  const createSlot = () => {
    if (!form.date) return;
    const startsAt = new Date(`${form.date}T${form.start}:00`).toISOString();
    const endsAt = new Date(`${form.date}T${form.end}:00`).toISOString();
    return run(
      () => postSms("meetings/slots", {
        startsAt, endsAt,
        location: form.location || undefined,
        note: form.note || undefined,
        // A video meeting needs BOTH; the server re-validates the URL.
        provider: form.provider || undefined,
        joinUrl: form.provider ? form.joinUrl : undefined,
        ...(picked ? { audience: { kind: picked.kind, ref: picked.ref } } : {}),
      }),
      "Slot opened.",
    );
  };

  return (
    <div className="space-y-6">
      {canHost && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Open a meeting slot</CardTitle>
            <CardDescription>
              Choose WHO it is for, then a time. One parent books a 1:1 appointment; a class, year group or
              whole-school meeting invites every parent in it — they see it on their own meetings page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* WHO comes first, deliberately: it changes what the meeting IS
                (a 1:1 appointment or a briefing) and therefore how the rest of
                the form reads. The options come from the SERVER, so this can
                never offer a scope the server would refuse. */}
            {audiences.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">For</span>
                {audiences.map((a, i) => (
                  <button
                    key={`${a.kind}:${a.ref ?? ""}`}
                    type="button"
                    onClick={() => setAudienceIdx(i)}
                    aria-pressed={audienceIdx === i}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      audienceIdx === i ? "border-primary bg-primary/10 text-primary" : "border-border"
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <input type="date" className="rounded-md border bg-background p-1.5 text-sm" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              <input type="time" className="rounded-md border bg-background p-1.5 text-sm" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
              <span className="text-sm text-muted-foreground">to</span>
              <input type="time" className="rounded-md border bg-background p-1.5 text-sm" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
              <input placeholder="Location (optional)" className="w-40 rounded-md border bg-background p-1.5 text-sm" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            {/* Optional video meeting: paste a link from Zoom/Meet/Teams/Jitsi.
                The server validates the host, and only releases the link to
                parents inside the join window. */}
            <select aria-label="Video platform" className="rounded-md border bg-background p-1.5 text-sm" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
              <option value="">In person</option>
              {MEETING_PROVIDERS.map((mp) => <option key={mp} value={mp}>{MEETING_PROVIDER_LABELS[mp]}</option>)}
            </select>
            {form.provider && (
              <input placeholder="https://… join link" className="w-56 rounded-md border bg-background p-1.5 text-sm" value={form.joinUrl} onChange={(e) => setForm({ ...form, joinUrl: e.target.value })} required />
            )}
              <Button size="sm" disabled={busy || !form.date} onClick={createSlot}>Open slot</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {canHost && mySlots.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Your slots</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {mySlots.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      {dateTime(s.startsAt)}
                      {/* WHO it is for, on every row. Its absence is what made
                          the page ambiguous: a parent could see a slot and have
                          no way to tell whether it was meant for them. */}
                      <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                        {s.audienceLabel}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      <JoinMeetingLink provider={s.provider} joinUrl={s.joinUrl} joinOpen={s.joinOpen} joinOpensAt={s.joinOpensAt} location={s.location} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      {s.booked > 0 ? (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">{s.booked}/{s.capacity} booked</span>
                      ) : s.active ? (
                        <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => run(() => sendSms("DELETE", `meetings/slots/${s.id}`), "Slot withdrawn.")}>withdraw</button>
                      ) : (
                        <span className="text-xs text-muted-foreground">withdrawn</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {canBook && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Book a meeting</CardTitle>
            <CardDescription>
              Only meetings your family is invited to — your child&apos;s own appointments, their class, their year
              group, and anything called for the whole school.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {openSlots.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">No open slots right now.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {openSlots.map((s) => (
                    <tr key={s.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">
                        {dateTime(s.startsAt)}
                        {/* WHY this meeting is in a parent's list. Without it the
                            page shows a time and a teacher and leaves the parent
                            to guess whether it concerns them. */}
                        <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {s.audienceLabel}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {s.teacherName ?? "Teacher"}{" · "}
                        <JoinMeetingLink provider={s.provider} joinUrl={s.joinUrl} joinOpen={s.joinOpen} joinOpensAt={s.joinOpensAt} location={s.location} />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span className="inline-flex items-center gap-1.5">
                          <select className="rounded-md border bg-background p-1 text-xs" value={childBy[s.id] ?? children[0]?.studentId ?? ""} onChange={(e) => setChildBy({ ...childBy, [s.id]: e.target.value })}>
                            {children.map((c) => <option key={c.studentId} value={c.studentId}>{c.studentName}</option>)}
                          </select>
                          <Button size="sm" disabled={busy || children.length === 0} onClick={() => run(() => postSms("meetings/bookings", { slotId: s.id, studentId: childBy[s.id] ?? children[0]?.studentId }), "Booked.")}>Book</Button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      {canBook && myBookings.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Your bookings</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {myBookings.map((b) => (
                  <tr key={b.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">{dateTime(b.startsAt)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{b.studentName} · {b.teacherName ?? "Teacher"}{b.location ? ` · ${b.location}` : ""}</td>
                    <td className="px-4 py-2 text-right">
                      <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => run(() => sendSms("DELETE", `meetings/bookings/${b.id}`), "Cancelled.")}>cancel</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}
