"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ReplyBox({ threadId }: { threadId: string }) {
  const router = useRouter();
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body) return;
    setBusy(true);
    const res = await fetch(`/api/sms/messages/threads/${threadId}/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }),
    });
    setBusy(false);
    if (res.ok) { setBody(""); router.refresh(); }
  };

  return (
    <form onSubmit={send} className="flex gap-2">
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="Reply…" className="flex-1" />
      <Button type="submit" disabled={busy || !body}>Send</Button>
    </form>
  );
}
