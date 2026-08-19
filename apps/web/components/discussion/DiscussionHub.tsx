"use client";

// Discussion Hub UI. Staff (canModerate) create groups + delete unwanted posts/
// comments; members post and comment. A selected group expands to show its posts.

import type { DiscussionGroupDto, DiscussionPostDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { LoadMore } from "@/components/shell/LoadMore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineSearch } from "@/components/common/InlineSearch";

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
  const [postCursor, setPostCursor] = React.useState<string | null>(null);
  const [newPost, setNewPost] = React.useState("");
  const [comment, setComment] = React.useState<Record<string, string>>({});

  const run = async (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string, reload?: string) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) { setMsg(ok); if (reload) await loadPosts(reload); else router.refresh(); } else setMsg(res.error ?? `Failed (${res.status}).`);
  };

  // Posts arrive one keyset page at a time. Without `cursor` this is a fresh open
  // (or a reload after a mutation) and REPLACES the list; with one it appends the
  // next page, so a long-running group loads on demand instead of all at once.
  const loadPosts = async (groupId: string, cursor?: string) => {
    setOpenId(groupId);
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const res = await fetch(`/api/sms/discussion/groups/${groupId}/posts${qs}`, { cache: "no-store" });
    if (!res.ok) return;
    const page = (await res.json()) as { items: Post[]; nextCursor: string | null };
    setPosts((prev) => (cursor ? [...prev, ...(page.items ?? [])] : (page.items ?? [])));
    setPostCursor(page.nextCursor ?? null);
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

      {/* /discussion/search existed with no search box. A pointer to the post,
          not the post — the group page is where you read it. */}
      <InlineSearch<{ id: string; groupId: string; body: string; groupName: string }>
        path="discussion/search"
        placeholder="Search discussions…"
        emptyLabel="No post matched."
        render={(hits) => (
          <ul className="divide-y divide-border/70 rounded-md border border-border">
            {hits.map((h) => (
              <li key={h.id} className="p-2 text-sm">
                <span className="font-medium">{h.groupName}</span>
                <p className="truncate text-xs text-muted-foreground">{h.body}</p>
              </li>
            ))}
          </ul>
        )}
      />

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
                      {/* Anyone reading may report. The people who see harmful
                          content first are the ones in the group, and most of
                          them are children — a moderator-only "delete" is not a
                          way to raise anything. Reporting never removes the
                          post; it opens a case a person reviews. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt("What is wrong with this post? A member of staff will review it.");
                          if (reason?.trim()) {
                            void run(
                              () => postSms(`discussion/posts/${post.id}/report`, { reason }),
                              "Reported. A member of staff will look at this.",
                              g.id,
                            );
                          }
                        }}
                      >
                        Report
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              <LoadMore hasMore={postCursor !== null} loading={busy} onClick={() => loadPosts(g.id, postCursor ?? undefined)} />
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
