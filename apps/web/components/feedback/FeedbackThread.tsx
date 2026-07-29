"use client";

import * as React from "react";
import type { FeedbackThreadDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readApiError } from "@/lib/api-error";

type Thread = Serialized<FeedbackThreadDto>;

/**
 * The two-way conversation on one feedback item. Reused by BOTH sides — the
 * sender (basePath="/api/sms/feedback", mySide="SENDER") and the platform team
 * (basePath="/api/sms/operator/feedback", mySide="PLATFORM"). It fetches the
 * thread lazily on mount and posts replies to `${basePath}/${id}/reply`.
 */
export function FeedbackThread({
  feedbackId,
  basePath,
  mySide,
  onReplied,
}: {
  feedbackId: string;
  basePath: string;
  mySide: "SENDER" | "PLATFORM";
  onReplied?: () => void;
}) {
  const [thread, setThread] = React.useState<Thread | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    const res = await fetch(`${basePath}/${feedbackId}/thread`);
    setLoading(false);
    if (!res.ok) {
      setErr(await readApiError(res));
      return;
    }
    setThread((await res.json()) as Thread);
  }, [basePath, feedbackId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const reply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(`${basePath}/${feedbackId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(await readApiError(res));
      return;
    }
    setBody("");
    await load();
    onReplied?.();
  };

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading conversation…</p>
      ) : thread && thread.messages.length > 0 ? (
        <ul className="space-y-2">
          {thread.messages.map((m) => {
            const mine = m.authorSide === mySide;
            return (
              <li key={m.id} className={mine ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    "max-w-[85%] rounded-lg px-3 py-2 text-sm " +
                    (m.authorSide === "PLATFORM"
                      ? "bg-primary/10 text-foreground"
                      : "bg-background border")
                  }
                >
                  <p className="mb-0.5 text-xs font-medium text-muted-foreground">
                    {m.authorName}
                    {mine ? " (you)" : ""} · {new Date(m.createdAt).toLocaleString()}
                  </p>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No replies yet. Start the conversation below.</p>
      )}

      <form onSubmit={reply} className="space-y-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={5000}
          rows={3}
          placeholder={mySide === "PLATFORM" ? "Reply to the sender…" : "Reply to the platform team…"}
        />
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={busy || !body.trim()}>
            {busy ? "Sending…" : "Send reply"}
          </Button>
          {err && <span className="text-sm text-destructive">{err}</span>}
        </div>
      </form>
    </div>
  );
}
