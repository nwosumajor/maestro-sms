"use client";

// Alumni Management UI. Staff record former students, filter by year, and
// broadcast a message to the email addresses on the alumni register.

import type { AlumnusDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Alumnus = Serialized<AlumnusDto>;

export function AlumniManager({ alumni }: { alumni: Alumnus[] }) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [f, setF] = React.useState({ name: "", email: "", graduationYear: "", lastClass: "", occupation: "" });
  const [bTitle, setBTitle] = React.useState("");
  const [bBody, setBBody] = React.useState("");

  const run = async (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) { setMsg(ok); router.refresh(); } else setMsg(res.error ?? "Request failed.");
  };

  /**
   * Reports what the broadcast ACTUALLY reached.
   *
   * The audience is the REGISTER'S OWN EMAIL, not a user account: a broadcast
   * used to be a notification, and the funnel drops external channels for a
   * non-ACTIVE recipient — which an alumnus is by definition.
   *
   * This used to say "it goes out to the alumni body", which contradicted the
   * card above it: a broadcast is a notification addressed to a user account,
   * and an alumnus recorded after the fact has none. A school with fifty on
   * file and three linked accounts was told it had gone out.
   */
  const sendBroadcast = async () => {
    setBusy(true);
    setMsg(null);
    const res = await postSms<{ queued: number; unreachable: number; noEmail: number }>("alumni/broadcast", {
      title: bTitle,
      body: bBody,
    });
    setBusy(false);
    if (!res.ok) {
      setMsg(res.error ?? "Request failed.");
      return;
    }
    const queued = res.data?.queued ?? 0;
    const noEmail = res.data?.noEmail ?? 0;
    /*
      A BROADCAST IS AN EMAIL TO THE REGISTER, NOT A NOTIFICATION.

      It used to be a notification addressed to a user account, and the funnel
      drops every external channel for a recipient whose status is not ACTIVE —
      which an alumnus is BY DEFINITION. So it reached almost nobody, and the
      few it did reach were the ones whose exit had never been processed.

      The audience is now the email on the alumni record itself, which is the
      contact detail this register exists to hold. Nothing is written into an
      account nobody can sign in to.
    */
    setMsg(
      `Emailed ${queued} alumn${queued === 1 ? "us" : "i"} from the register.` +
        (noEmail > 0
          ? ` ${noEmail} ${noEmail === 1 ? "has" : "have"} no email address on file and could not be reached —` +
            ` add one to include them next time.`
          : ""),
    );
    setBTitle("");
    setBBody("");
    router.refresh();
  };

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      <Card>
        <CardHeader><CardTitle className="text-base">Add an alumnus</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5"><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Email</Label><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Grad year</Label><Input className="w-24" type="number" value={f.graduationYear} onChange={(e) => setF({ ...f, graduationYear: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Occupation</Label><Input value={f.occupation} onChange={(e) => setF({ ...f, occupation: e.target.value })} /></div>
          <Button disabled={busy || !f.name} onClick={() => run(() => postSms("alumni", { name: f.name, email: f.email || undefined, graduationYear: f.graduationYear ? Number(f.graduationYear) : undefined, occupation: f.occupation || undefined }), "Added.").then(() => setF({ name: "", email: "", graduationYear: "", lastClass: "", occupation: "" }))}>Add</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Broadcast to alumni</CardTitle>
          <CardDescription>Emails every alumnus with an address on the register. It does not go to their old school login — that account is closed once they leave.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5"><Label>Title</Label><Input value={bTitle} onChange={(e) => setBTitle(e.target.value)} /></div>
          <div className="space-y-1.5 flex-1 min-w-60"><Label>Message</Label><Input value={bBody} onChange={(e) => setBBody(e.target.value)} /></div>
          <Button
            variant="outline"
            disabled={busy || !bTitle || !bBody}
            onClick={() => void sendBroadcast()}
          >
            Send
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Alumni ({alumni.length})</CardTitle>
          {alumni.some((a) => !a.email) && (
            <CardDescription>
              {alumni.filter((a) => !a.email).length} of {alumni.length} have no email address and will not
              receive a broadcast.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {alumni.length === 0 ? <p className="text-sm text-muted-foreground">No alumni yet.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Name</th><th className="py-1 pr-3 font-medium">Year</th>
                <th className="py-1 pr-3 font-medium">Occupation</th><th className="py-1 font-medium">Email</th>
              </tr></thead>
              <tbody>
                {alumni.map((a) => (
                  <tr key={a.id} className="border-b border-border/50">
                    <td className="py-1 pr-3">{a.name}</td><td className="py-1 pr-3">{a.graduationYear ?? "—"}</td>
                    <td className="py-1 pr-3">{a.occupation ?? "—"}</td>
                    {/* AN EMPTY EMAIL IS THE ONE THING TO ACT ON.
                        A broadcast goes to this column, so a blank here is an
                        alumnus the school cannot reach — the same count the
                        send reports afterwards, said where it can be fixed
                        rather than only after a send. "—" in muted grey read
                        as an optional detail. */}
                    <td className="py-1">
                      {a.email ?? (
                        <span className="text-xs text-amber-600 dark:text-amber-400">
                          No email — cannot be reached
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
