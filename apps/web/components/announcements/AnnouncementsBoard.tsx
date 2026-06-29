"use client";

import type { AnnouncementDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Announcement = Serialized<AnnouncementDto>;

export function AnnouncementsBoard({
  announcements,
  canManage,
}: {
  announcements: Announcement[];
  canManage: boolean;
}) {
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
    } else setMsg(`Failed (${res.status}).`);
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
        {announcements.length === 0 && <p className="text-sm text-muted-foreground">No announcements yet.</p>}
        {announcements.map((a) => (
          <Card key={a.id}>
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle className="text-base">{a.title}</CardTitle>
                <CardDescription>
                  {a.authorName} · {new Date(a.createdAt).toLocaleDateString()}{" "}
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
    </div>
  );
}
