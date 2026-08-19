"use client";

// Polling System UI. Staff (canManage) create polls + close them and see live
// tallies; members cast ONE anonymous vote and see results only after the poll
// closes (or immediately if staff). No voter identity is ever shown.

import type { PollDto, Serialized } from "@sms/types";
import { usePaged, type Paged } from "@/lib/paged";
import { LoadMore } from "@/components/shell/LoadMore";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms, sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Poll = Serialized<PollDto>;

export function PollBoard({ page, canManage }: { page: Paged<Poll>; canManage: boolean }) {
  const router = useRouter();
  const { items: polls, hasMore, loading, loadMore } = usePaged<Poll>(page, "polls");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [audience, setAudience] = React.useState("ALL");
  const [opts, setOpts] = React.useState<string[]>(["", ""]);
  const [editing, setEditing] = React.useState<string | null>(null);

  const run = async (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) { setMsg(ok); router.refresh(); } else setMsg(res.error ?? "Request failed.");
  };

  const pct = (votes: number, total: number) => (total > 0 ? Math.round((votes / total) * 100) : 0);

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {canManage && (
        <Card>
          <CardHeader><CardTitle className="text-base">Create a poll</CardTitle><CardDescription>Anonymous — you see live tallies, voters see results after it closes.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5 flex-1 min-w-60"><Label>Question</Label><Input value={q} onChange={(e) => setQ(e.target.value)} /></div>
              <div className="space-y-1.5">
                <Label>Audience</Label>
                <select value={audience} onChange={(e) => setAudience(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="ALL">Everyone</option><option value="STUDENTS">Students</option><option value="STAFF">Staff</option>
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Options</Label>
              {opts.map((o, i) => (
                <Input key={i} value={o} onChange={(e) => setOpts((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${i + 1}`} className="mb-1.5" />
              ))}
              <Button variant="outline" size="sm" type="button" onClick={() => setOpts((a) => [...a, ""])}>+ Add option</Button>
            </div>
            <Button disabled={busy || !q || opts.filter((o) => o.trim()).length < 2} onClick={() => run(() => postSms("polls", { question: q, audience, options: opts.filter((o) => o.trim()) }), "Poll created.").then(() => { setQ(""); setOpts(["", ""]); })}>Create poll</Button>
          </CardContent>
        </Card>
      )}

      {polls.length === 0 && <p className="text-sm text-muted-foreground">No polls.</p>}

      {polls.map((poll) => (
        <Card key={poll.id}>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {poll.question}
              <Badge variant={poll.status === "CLOSED" ? "outline" : "secondary"}>{poll.status}</Badge>
              <Badge variant="outline" className="font-normal">{poll.audience}</Badge>
            </CardTitle>
            <CardDescription>By {poll.createdByName} · {poll.totalVotes} vote{poll.totalVotes === 1 ? "" : "s"}{poll.hasVoted ? " · you voted" : ""}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {poll.options.map((o) => (
              <div key={o.id} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm">{o.label}</span>
                  {poll.resultsVisible
                    ? <span className="text-xs text-muted-foreground">{o.votes} ({pct(o.votes, poll.totalVotes)}%)</span>
                    : (!poll.hasVoted && poll.status === "OPEN" && <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`polls/${poll.id}/vote`, { optionId: o.id }), "Vote recorded — anonymously.")}>Vote</Button>)}
                </div>
                {poll.resultsVisible && (
                  <div className="h-2 w-full overflow-hidden rounded bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${pct(o.votes, poll.totalVotes)}%` }} />
                  </div>
                )}
              </div>
            ))}
            {!poll.resultsVisible && poll.hasVoted && <p className="text-xs text-muted-foreground">You voted. Results appear when the poll closes.</p>}
            {canManage && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {poll.status === "OPEN" && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`polls/${poll.id}/close`, {}), "Poll closed.")}>Close poll</Button>
                )}
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(editing === poll.id ? null : poll.id)}>
                  {editing === poll.id ? "Cancel" : "Edit"}
                </Button>
                {/* Only an unanswered poll can go: votes are append-only in the
                    database, so an answered one is closed instead. Disabled
                    with the reason rather than hidden. */}
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy || poll.totalVotes > 0}
                  title={poll.totalVotes > 0 ? "People have voted — close this poll instead of deleting it" : undefined}
                  onClick={() => {
                    if (window.confirm("Delete this poll? This cannot be undone.")) {
                      void run(() => sendSms("DELETE", `polls/${poll.id}`), "Poll deleted.");
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            )}
            {canManage && editing === poll.id && <PollEditor poll={poll} busy={busy} run={run} />}
          </CardContent>
        </Card>
      ))}

      <LoadMore hasMore={hasMore} loading={loading} onClick={loadMore} />
    </div>
  );
}

/**
 * Correcting a poll in place.
 *
 * Once somebody has voted, the question, audience and options are fixed — a
 * tally has to stay attached to the question that was actually asked. The
 * deadline is the exception and stays editable, which is the change people
 * actually need on a poll that is already running.
 *
 * The inputs are DISABLED rather than hidden: a staff member wondering why they
 * cannot fix a typo is better served by seeing the field greyed out with the
 * reason beside it than by the field vanishing.
 */
function PollEditor({
  poll,
  busy,
  run,
}: {
  poll: Poll;
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string) => Promise<void>;
}) {
  const voted = poll.totalVotes > 0;
  const [question, setQuestion] = React.useState(poll.question);
  const [audience, setAudience] = React.useState(poll.audience);
  const [labels, setLabels] = React.useState<string[]>(poll.options.map((o) => o.label));
  const [closesAt, setClosesAt] = React.useState(poll.closesAt ? String(poll.closesAt).slice(0, 10) : "");

  return (
    <div className="mt-2 space-y-3 rounded-md border border-primary/40 p-3">
      {voted && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          {poll.totalVotes} {poll.totalVotes === 1 ? "person has" : "people have"} voted, so the question, audience and options
          are fixed — the tally has to stay attached to what was actually asked. You can still change the closing date, or close
          this poll and post a corrected one.
        </p>
      )}
      <div className="space-y-1.5"><Label>Question</Label>
        <Input value={question} disabled={voted} onChange={(e) => setQuestion(e.target.value)} />
      </div>
      <div className="space-y-1.5"><Label>Audience</Label>
        <select value={audience} disabled={voted} onChange={(e) => setAudience(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50">
          <option value="ALL">Everyone</option><option value="STUDENTS">Students</option><option value="STAFF">Staff</option>
        </select>
      </div>
      <div className="space-y-1.5"><Label>Closes on</Label>
        <Input type="date" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
      </div>
      <div className="space-y-1.5"><Label>Options</Label>
        {labels.map((l, i) => (
          <Input key={i} value={l} disabled={voted} className="mb-1"
            onChange={(e) => setLabels(labels.map((x, xi) => (xi === i ? e.target.value : x)))} aria-label={`Option ${i + 1}`} />
        ))}
        {!voted && labels.length < 10 && (
          <Button size="sm" variant="outline" onClick={() => setLabels([...labels, ""])}>Add option</Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => {
          // Two calls because they are two rules: the question/audience/deadline
          // and the option list are refused independently by the server.
          void run(async () => {
            const a = await sendSms("PUT", `polls/${poll.id}`, voted
              ? { closesAt: closesAt || null }
              : { question, audience, closesAt: closesAt || null });
            if (!a.ok || voted) return a;
            return sendSms("PUT", `polls/${poll.id}/options`, { options: labels });
          }, "Poll updated.");
        }}>Save changes</Button>
      </div>
    </div>
  );
}
