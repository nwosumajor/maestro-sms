"use client";

import type { AnnouncementDto, AnnouncementPageDto, Serialized } from "@sms/types";
import { useFormat } from "@/components/shell/RegionProvider";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Announcement = Serialized<AnnouncementDto>;
type Board = Serialized<AnnouncementPageDto>;

export function AnnouncementsBoard({
  board,
  query,
  canManage,
}: {
  /** A PAGE, not an array: it carries the total behind the cap. A board with
   *  three years of notices out of reach must not look like a complete one. */
  board: Board;
  /** The search the caller ran, so the box keeps it. */
  query: string;
  canManage: boolean;
}) {
  // Dates follow the SCHOOL's calendar, not the browser's.
  const announcements = board.items;
  const { shortDate } = useFormat();
  const router = useRouter();
  const [f, setF] = React.useState({ title: "", body: "", audience: "ALL" });
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title || !f.body) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/announcements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(f),
    });
    setBusy(false);
    if (res.ok) {
      setF({ title: "", body: "", audience: "ALL" });
      router.refresh();
    } else setMsg(await readApiError(res));
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/sms/announcements/${id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Post an announcement</CardTitle>
            <CardDescription>Visible to everyone you target across your school.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={post} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="an-title">Title</Label>
                <Input id="an-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="an-body">Message</Label>
                <Textarea id="an-body" rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
              </div>
              <div className="flex items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="an-aud">Audience</Label>
                  <select
                    id="an-aud"
                    value={f.audience}
                    onChange={(e) => setF({ ...f, audience: e.target.value })}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="ALL">Everyone</option>
                    <option value="STUDENTS">Students</option>
                    <option value="STAFF">Staff</option>
                  </select>
                </div>
                <Button type="submit" disabled={busy}>{busy ? "Posting…" : "Post announcement"}</Button>
              </div>
              {msg && <p className="text-sm text-destructive">{msg}</p>}
            </form>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {/* SEARCH AND REACH. A board answers "what did the school say about X",
            and the cap made three to four years of that unanswerable. Both
            controls narrow in SQL. */}
        <form method="GET" className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={query}
            aria-label="Search every notice"
            placeholder="Search every notice"
            className="h-8 min-w-52 flex-1 rounded-md border border-border bg-background px-2 text-sm"
          />
          <button type="submit" className="h-8 rounded-md border border-border px-3 text-xs hover:bg-muted">
            Search
          </button>
          <span className="text-xs text-muted-foreground">
            {board.total > board.shown
              ? `showing ${board.shown} of ${board.total}`
              : `${board.total} notice${board.total === 1 ? "" : "s"}`}
            {query ? ` matching “${query}”` : ""}
          </span>
        </form>
        {announcements.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {query ? `No notice matches “${query}”.` : "No announcements yet."}
          </p>
        )}
        {announcements.map((a) => (
          <Card key={a.id}>
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle className="text-base">{a.title}</CardTitle>
                <CardDescription>
                  {a.authorName} · {shortDate(a.createdAt)}{" "}
                  <Badge variant="outline" className="ml-1 text-[10px]">{a.audience.toLowerCase()}</Badge>
                </CardDescription>
              </div>
              {canManage && (
                <Button size="sm" variant="ghost" className="h-7" onClick={() => remove(a.id)}>Delete</Button>
              )}
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm">{a.body}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    
      {/* A cap is only safe when the rest is reachable. */}
      {board.total > board.pageSize && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {board.page > 1 && (
            <a className="underline hover:text-foreground" href={`/announcements?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(board.page - 1) })}`}>
              ← newer
            </a>
          )}
          <span>page {board.page} of {Math.max(1, Math.ceil(board.total / board.pageSize))}</span>
          {board.page * board.pageSize < board.total && (
            <a className="underline hover:text-foreground" href={`/announcements?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(board.page + 1) })}`}>
              older →
            </a>
          )}
        </div>
      )}
</div>
  );
}
