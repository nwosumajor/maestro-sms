"use client";

import type { UserSummaryDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type User = Serialized<UserSummaryDto>;

export function SendAnnouncement({ users }: { users: User[] }) {
  const router = useRouter();
  const [recipientId, setRecipientId] = React.useState(users[0]?.id ?? "");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recipientId || !title || !body) return;
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientId, type: "ANNOUNCEMENT", title, body }),
    });
    setBusy(false);
    if (res.ok) { setTitle(""); setBody(""); setMsg("Sent."); router.refresh(); }
    else setMsg(res.status === 403 ? "You can't send to that recipient." : `Failed (${res.status}).`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Send an announcement</CardTitle>
        <CardDescription>Goes to the recipient's inbox (and email asynchronously).</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="space-y-1.5">
              <Label htmlFor="an-to">To</Label>
              <select id="an-to" value={recipientId} onChange={(e) => setRecipientId(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-64">
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}{u.roles.length ? ` (${u.roles.join(", ")})` : ""}</option>
                ))}
              </select>
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="an-title">Title</Label>
              <Input id="an-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Mid-term break" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="an-body">Message</Label>
            <Textarea id="an-body" value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send"}</Button>
            {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
