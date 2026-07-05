"use client";

// Alumni Management UI. Staff record former students, filter by year, and
// broadcast a message to alumni with linked accounts.

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
          <CardDescription>Sends to alumni who have a linked account.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5"><Label>Title</Label><Input value={bTitle} onChange={(e) => setBTitle(e.target.value)} /></div>
          <div className="space-y-1.5 flex-1 min-w-60"><Label>Message</Label><Input value={bBody} onChange={(e) => setBBody(e.target.value)} /></div>
          <Button variant="outline" disabled={busy || !bTitle || !bBody} onClick={() => run(() => postSms("alumni/broadcast", { title: bTitle, body: bBody }), "Broadcast sent.").then(() => { setBTitle(""); setBBody(""); })}>Send</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Alumni ({alumni.length})</CardTitle></CardHeader>
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
                    <td className="py-1 pr-3">{a.occupation ?? "—"}</td><td className="py-1 text-muted-foreground">{a.email ?? "—"}</td>
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
