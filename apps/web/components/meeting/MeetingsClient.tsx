"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { MeetingSlotDto, MeetingBookingDto, Serialized } from "@sms/types";
import { MEETING_PROVIDERS, MEETING_PROVIDER_LABELS } from "@sms/types";
import { JoinMeetingLink } from "@/components/meeting/JoinMeetingLink";
import { sendSms, postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PeoplePicker, type Person } from "./PeoplePicker";
import { StudentPicker } from "@/components/people/StudentPicker";
import { Label } from "@/components/ui/label";
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
  /**
   * "Open — any parent can book" is not one of the server's AUDIENCES; it is the
   * absence of one, so it is prepended here rather than returned by the API.
   *
   * It has to exist, and has to be first. The server's list starts with
   * "One pupil (appointment)" carrying a NULL ref, and the page always sent
   * whatever was selected — so the default selection produced
   * "A student meeting needs a student" for every host, and the ordinary
   * bookable slot the module was built around could not be created from this
   * page at all. Open is also the only choice that notifies nobody, which is
   * what a default should be.
   */
  const OPEN: AudienceChoice = { kind: "OPEN", ref: null, label: "Open — any parent can book" };
  const options = React.useMemo(() => [OPEN, ...audiences], [audiences]);
  const [audienceIdx, setAudienceIdx] = React.useState(0);
  const chosen = options[audienceIdx] ?? OPEN;
  // OPEN means "send no audience at all"; every other choice declares one.
  const picked = chosen.kind === "OPEN" ? null : chosen;
  // A STUDENT audience needs the pupil it is about — the server's option
  // carries a null ref and there was no way to fill it in.
  const [studentId, setStudentId] = React.useState("");
  const needsStudent = chosen.kind === "STUDENT";
  const audienceRef = needsStudent ? studentId : (picked?.ref ?? null);
  // The two pickers. Invitees only apply to a SELECTED audience; co-hosts to any.
  const [invitees, setInvitees] = React.useState<Person[]>([]);
  const [cohosts, setCohosts] = React.useState<Person[]>([]);

  const createSlot = () => {
    if (!form.date) return;
    if (needsStudent && !studentId) {
      setMsg("Choose which pupil this appointment is about.");
      return;
    }
    // Announcing is irreversible: the notification is on its way before the
    // page repaints. Anything wider than one family gets one confirmation
    // naming the group, so a mis-clicked chip is not a message to the school.
    if (picked && !needsStudent && !confirm(`Notify ${chosen.label.toLowerCase()} that this meeting has been called?`)) {
      return;
    }
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
        ...(picked ? { audience: { kind: picked.kind, ref: audienceRef } } : {}),
        ...(chosen.kind === "SELECTED" ? { inviteeIds: invitees.map((i) => i.id) } : {}),
        ...(cohosts.length ? { cohostIds: cohosts.map((c) => c.id) } : {}),
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
            {options.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">For</span>
                {options.map((a, i) => (
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
            {/* WHAT THIS WILL DO, next to the button that does it. An audience
                is not a filter — declaring one sends a notification to every
                family in it, at once, with no way to unsend. */}
            <p className={`text-xs ${picked && !needsStudent ? "text-amber-700 dark:text-amber-500" : "text-muted-foreground"}`}>
              {chosen.kind === "OPEN"
                ? "Nobody is notified. Parents find this slot on their meetings page and book it."
                : needsStudent
                  ? "That pupil's parents are notified when you open this."
                  : `${chosen.label} are notified as soon as you open this. It cannot be unsent.`}
            </p>

            {needsStudent && (
              <div className="space-y-1.5">
                <Label>Which pupil</Label>
                <StudentPicker
                  value={studentId}
                  onChange={(id: string) => setStudentId(id)}
                  placeholder="Search the pupil this appointment is about…"
                />
              </div>
            )}

            {/* Shown only for SELECTED: a search box for a scope that does not
                use one would be a control that does nothing. */}
            {chosen.kind === "SELECTED" && (
              <PeoplePicker
                kind="parent"
                label="Which parents"
                hint="Search and tick the families to invite. Only they will see this meeting."
                value={invitees}
                onChange={setInvitees}
                max={500}
              />
            )}

            {/* Colleagues attending, for any scope. The organiser is you and is
                never listed here — adding yourself is the one thing this cannot
                usefully do. */}
            <PeoplePicker
              kind="meeting-host"
              label="Colleagues attending (optional)"
              hint="They will see the meeting in their own list and get the join link, and are told they have been added."
              value={cohosts}
              onChange={setCohosts}
              max={20}
            />

            <div className="flex flex-wrap items-end gap-2">
              <input aria-label="Slot date" type="date" className="rounded-md border bg-background p-1.5 text-sm" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              <input aria-label="Slot start time" type="time" className="rounded-md border bg-background p-1.5 text-sm" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
              <span className="text-sm text-muted-foreground">to</span>
              <input aria-label="Slot end time" type="time" className="rounded-md border bg-background p-1.5 text-sm" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
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
                        // WHO booked, and a way to release each one. The host
                        // used to get this count and nothing else: no name to
                        // know who was coming, and no way to free a slot they
                        // could no longer keep — withdrawing answered "cancel
                        // those first" and cancelling was refused. These names
                        // are on the host's own view of their own slot; the
                        // parent-facing list never carries them.
                        <div className="flex flex-col items-end gap-1">
                          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">{s.booked}/{s.capacity} booked</span>
                          {(s.bookings ?? []).map((b) => (
                            <span key={b.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                              {b.studentName ?? "Pupil"}{b.parentName ? ` · ${b.parentName}` : ""}
                              <button
                                className="hover:text-destructive"
                                disabled={busy}
                                onClick={() => run(() => sendSms("DELETE", `meetings/bookings/${b.id}`, {}), "Booking cancelled.")}
                              >
                                Cancel
                              </button>
                            </span>
                          ))}
                        </div>
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
                        {s.teacherName ?? "Teacher"}
                        {/* Who else will be there. A parent walking into a room
                            with three staff they were not told about is the
                            thing this line prevents. */}
                        {(s.cohosts ?? []).length > 0 && (
                          <span className="text-xs"> with {(s.cohosts ?? []).map((c) => c.name).join(", ")}</span>
                        )}
                        {" · "}
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
