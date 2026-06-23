"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Contact { id: string; name: string; roles: string[] }

export function Composer({ contacts }: { contacts: Contact[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [recipientId, setRecipientId] = React.useState(contacts[0]?.id ?? "");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recipientId || !subject || !body) return;
    setBusy(true);
    const res = await fetch("/api/sms/messages/threads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientId, subject, body }),
    });
    setBusy(false);
    if (res.ok) {
      const t = (await res.json()) as { id: string };
      setSubject(""); setBody(""); setOpen(false);
      router.push(`/messages?thread=${t.id}`);
      router.refresh();
    }
  };

  if (!open) return <Button size="sm" onClick={() => setOpen(true)}>New message</Button>;

  return (
    <form onSubmit={send} className="space-y-2 rounded-md border border-border p-3">
      <div className="space-y-1.5">
        <Label htmlFor="m-to">To</Label>
        <select id="m-to" value={recipientId} onChange={(e) => setRecipientId(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.roles.length ? ` (${c.roles.join(", ")})` : ""}</option>)}
        </select>
      </div>
      <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Message" />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>Send</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
