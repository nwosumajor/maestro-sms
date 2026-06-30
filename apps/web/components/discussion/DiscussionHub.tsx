"use client";

// Discussion Hub UI. Staff (canModerate) create groups + delete unwanted posts/
// comments; members post and comment. A selected group expands to show its posts.

import type { DiscussionGroupDto, DiscussionPostDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Group = Serialized<DiscussionGroupDto>;
type Post = Serialized<DiscussionPostDto>;

export function DiscussionHub({ groups, canModerate }: { groups: Group[]; canModerate: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [gName, setGName] = React.useState("");
  const [gAudience, setGAudience] = React.useState("ALL");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [posts, setPosts] = React.useState<Post[]>([]);
  const [newPost, setNewPost] = React.useState("");
  const [comment, setComment] = React.useState<Record<string, string>>({});

  const run = async (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string, reload?: string) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) { setMsg(ok); if (reload) await loadPosts(reload); else router.refresh(); } else setMsg(res.error ?? `Failed (${res.status}).`);
  };

  const loadPosts = async (groupId: string) => {
    setOpenId(groupId);
    const res = await fetch(`/api/sms/discussion/groups/${groupId}/posts`, { cache: "no-store" });
    if (res.ok) setPosts((await res.json()) as Post[]);
  };

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {canModerate && (
        <Card>
          <CardHeader><CardTitle className="text-base">Create a group</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label>Name</Label><Input value={gName} onChange={(e) => setGName(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label>Audience</Label>
              <select value={gAudience} onChange={(e) => setGAudience(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="ALL">Everyone</option><option value="STUDENTS">Students</option><option value="STAFF">Staff</option>
              </select>
            </div>
            <Button disabled={busy || !gName} onClick={() => run(() => postSms("discussion/groups", { name: gName, audience: gAudience }), "Group created.").then(() => setGName(""))}>Create</Button>
          </CardContent>
        </Card>
      )}

      {groups.map((g) => (
        <Card key={g.id}>
          <CardHeader className="cursor-pointer" onClick={() => (openId === g.id ? setOpenId(null) : loadPosts(g.id))}>
            <CardTitle className="text-base flex items-center gap-2">{g.name} <Badge variant="outline" className="font-normal">{g.audience}</Badge></CardTitle>
            <CardDescription>{g.postCount} post{g.postCount === 1 ? "" : "s"} · by {g.createdByName}</CardDescription>
          </CardHeader>
          {openId === g.id && (
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input value={newPost} onChange={(e) => setNewPost(e.target.value)} placeholder="Share something…" />
                <Button size="sm" disabled={busy || !newPost.trim()} onClick={() => run(() => postSms(`discussion/groups/${g.id}/posts`, { body: newPost }), "Posted.", g.id).then(() => setNewPost(""))}>Post</Button>
              </div>
              {posts.map((post) => (
                <div key={post.id} className="rounded-md border border-border p-2 space-y-1.5">
                  <p className="text-sm"><span className="font-medium">{post.authorName}:</span> {post.body}</p>
                  {post.comments.map((c) => (
                    <p key={c.id} className="ml-4 text-sm text-muted-foreground"><span className="font-medium">{c.authorName}:</span> {c.body}
                      {canModerate && !c.deleted && <button className="ml-2 text-xs text-destructive" onClick={() => run(() => deleteSms(`discussion/comments/${c.id}`), "Deleted.", g.id)}>delete</button>}
                    </p>
                  ))}
                  {!post.deleted && (
                    <div className="ml-4 flex gap-2">
                      <Input value={comment[post.id] ?? ""} onChange={(e) => setComment((m) => ({ ...m, [post.id]: e.target.value }))} placeholder="Reply…" className="h-8" />
                      <Button size="sm" variant="outline" disabled={busy || !(comment[post.id] ?? "").trim()} onClick={() => run(() => postSms(`discussion/posts/${post.id}/comments`, { body: comment[post.id] }), "Commented.", g.id).then(() => setComment((m) => ({ ...m, [post.id]: "" })))}>Reply</Button>
                      {canModerate && <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => run(() => deleteSms(`discussion/posts/${post.id}`), "Post removed.", g.id)}>Delete post</Button>}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      ))}
    </div>
  );
}

// DELETE via the BFF (postSms is POST-only).
async function deleteSms(path: string): Promise<{ ok: boolean; status: number; error: string | null }> {
  const res = await fetch(`/api/sms/${path}`, { method: "DELETE" });
  return { ok: res.ok, status: res.status, error: res.ok ? null : `Failed (${res.status})` };
}
