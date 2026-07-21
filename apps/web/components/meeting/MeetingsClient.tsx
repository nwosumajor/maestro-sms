"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { MeetingSlotDto, MeetingBookingDto, Serialized } from "@sms/types";
import { sendSms, postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dateTime } from "@/lib/format";

type Slot = Serialized<MeetingSlotDto>;
type Booking = Serialized<MeetingBookingDto>;

// Parent-teacher meetings. Hosts (teachers/staff) open slots and see bookings;
// parents browse open slots and book one for a child. The two panels render by
// what the caller can do.
export function MeetingsClient({
  canHost,
  canBook,
  mySlots,
  openSlots,
  myBookings,
  children,
}: {
  canHost: boolean;
  canBook: boolean;
  mySlots: Slot[];
  openSlots: Slot[];
  myBookings: Booking[];
  children: { studentId: string; studentName: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ date: "", start: "09:00", end: "09:30", location: "", note: "" });
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

  const createSlot = () => {
    if (!form.date) return;
    const startsAt = new Date(`${form.date}T${form.start}:00`).toISOString();
    const endsAt = new Date(`${form.date}T${form.end}:00`).toISOString();
    return run(
      () => postSms("meetings/slots", { startsAt, endsAt, location: form.location || undefined, note: form.note || undefined }),
      "Slot opened.",
    );
  };

  return (
    <div className="space-y-6">
      {canHost && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Open a meeting slot</CardTitle>
            <CardDescription>Parents can book an available slot for a chat about their child.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <input type="date" className="rounded-md border bg-background p-1.5 text-sm" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              <input type="time" className="rounded-md border bg-background p-1.5 text-sm" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
              <span className="text-sm text-muted-foreground">to</span>
              <input type="time" className="rounded-md border bg-background p-1.5 text-sm" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
              <input placeholder="Location (optional)" className="w-40 rounded-md border bg-background p-1.5 text-sm" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
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
                    <td className="px-4 py-2">{dateTime(s.startsAt)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{s.location ?? "—"}</td>
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
            <CardDescription>Available slots with your child&apos;s teachers.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {openSlots.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">No open slots right now.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {openSlots.map((s) => (
                    <tr key={s.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">{dateTime(s.startsAt)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{s.teacherName ?? "Teacher"}{s.location ? ` · ${s.location}` : ""}</td>
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
