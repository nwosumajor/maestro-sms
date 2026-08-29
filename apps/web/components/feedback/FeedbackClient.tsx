"use client";

import * as React from "react";
import { useFormat } from "@/components/shell/RegionProvider";
import { useRouter } from "next/navigation";
import type { MyFeedbackDto, FeedbackKind, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { FeedbackThread } from "@/components/feedback/FeedbackThread";

type Mine = Serialized<MyFeedbackDto>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  OPEN: "outline",
  REVIEWED: "secondary",
  RESOLVED: "default",
  DISMISSED: "destructive",
};

export function FeedbackClient({ mine }: { mine: Mine[] }) {
  const router = useRouter();
  const [kind, setKind] = React.useState<FeedbackKind>("COMPLAINT");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, subject, body }),
    });
    setBusy(false);
    if (res.ok) {
      setSubject("");
      setBody("");
      setKind("COMPLAINT");
      setMsg("Thanks — your feedback was sent to the platform team.");
      router.refresh();
    } else {
      setMsg(await readApiError(res));
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New message</CardTitle>
          <CardDescription>
            Choose whether this is a complaint about something that isn&apos;t working, or a suggestion for a feature you&apos;d like to
            see. Give it a clear subject and describe it as fully as you can.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="fb-kind">Type</Label>
              <select
                id="fb-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as FeedbackKind)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="COMPLAINT">Complaint / problem report</option>
                <option value="SUGGESTION">Feature suggestion</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fb-subject">Subject</Label>
              <Input
                id="fb-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                required
                placeholder={kind === "SUGGESTION" ? "e.g. Add bulk photo upload for students" : "e.g. Report card PDF fails to download"}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fb-body">Details</Label>
              <Textarea
                id="fb-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={5000}
                required
                rows={7}
                placeholder="What happened, or what would you like the platform to do?"
              />
              <p className="text-xs text-muted-foreground">{body.length}/5000</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy || !subject.trim() || !body.trim()}>
                {busy ? "Sending…" : "Send to platform team"}
              </Button>
              {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your messages</CardTitle>
          <CardDescription>The complaints and suggestions you&apos;ve sent, and where each one stands.</CardDescription>
        </CardHeader>
        <CardContent>
          {mine.length === 0 ? (
            <p className="text-sm text-muted-foreground">You haven&apos;t sent any feedback yet.</p>
          ) : (
            <ul className="space-y-3">
              {mine.map((f) => (
                <MyFeedbackItem key={f.id} f={f} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MyFeedbackItem({ f }: { f: Mine }) {
  // Dates follow the SCHOOL's calendar, not the browser's.
  const { shortDate } = useFormat();
  const [open, setOpen] = React.useState(false);
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{f.subject}</p>
          <p className="text-xs text-muted-foreground">
            {f.kind === "SUGGESTION" ? "Suggestion" : "Complaint"} · {shortDate(f.createdAt)}
          </p>
        </div>
        <Badge variant={STATUS_VARIANT[f.status] ?? "outline"}>{f.status}</Badge>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{f.body}</p>
      {f.reviewNote && (
        <p className="mt-2 rounded bg-muted/50 p-2 text-sm">
          <span className="font-medium">Note from platform team:</span> {f.reviewNote}
        </p>
      )}
      <button type="button" onClick={() => setOpen((v) => !v)} className="mt-2 text-sm font-medium text-primary underline">
        {open ? "Hide conversation" : "View conversation & reply"}
      </button>
      {open && (
        <div className="mt-2">
          <FeedbackThread feedbackId={f.id} basePath="/api/sms/feedback" mySide="SENDER" />
        </div>
      )}
    </li>
  );
}
