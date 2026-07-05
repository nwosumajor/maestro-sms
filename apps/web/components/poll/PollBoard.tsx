"use client";

// Polling System UI. Staff (canManage) create polls + close them and see live
// tallies; members cast ONE anonymous vote and see results only after the poll
// closes (or immediately if staff). No voter identity is ever shown.

import type { PollDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Poll = Serialized<PollDto>;

export function PollBoard({ polls, canManage }: { polls: Poll[]; canManage: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [audience, setAudience] = React.useState("ALL");
  const [opts, setOpts] = React.useState<string[]>(["", ""]);

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
            {canManage && poll.status === "OPEN" && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`polls/${poll.id}/close`, {}), "Poll closed.")}>Close poll</Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
