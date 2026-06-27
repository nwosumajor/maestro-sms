"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { StaffChecklistDto, StaffDocumentDto, TrainingRecordDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Checklist = Serialized<StaffChecklistDto>;
type Doc = Serialized<StaffDocumentDto>;
type Training = Serialized<TrainingRecordDto>;

const DOC_KINDS = ["CONTRACT", "WORK_PERMIT", "CERTIFICATION", "MEDICAL", "OTHER"] as const;

export function StaffLifecyclePanel({
  userId,
  checklists,
  documents,
  training,
}: {
  userId: string;
  checklists: Checklist[];
  documents: Doc[];
  training: Training[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  const post = async (path: string, body: unknown, key: string) => {
    setBusy(key);
    const res = await fetch(`/api/sms/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(null);
    if (res.ok) router.refresh();
    return res.ok;
  };

  return (
    <div className="space-y-6">
      {/* Onboarding / offboarding */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Onboarding / offboarding</CardTitle>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy === "on"} onClick={() => post(`hr/staff/${userId}/checklists`, { type: "ONBOARDING" }, "on")}>+ Onboarding</Button>
            <Button size="sm" variant="outline" disabled={busy === "off"} onClick={() => post(`hr/staff/${userId}/checklists`, { type: "OFFBOARDING" }, "off")}>+ Offboarding</Button>
          </span>
        </CardHeader>
        <CardContent className="space-y-4">
          {checklists.length === 0 ? (
            <p className="text-sm text-muted-foreground">No checklists yet.</p>
          ) : checklists.map((c) => (
            <div key={c.id} className="rounded-md border border-border p-3">
              <p className="mb-2 text-sm font-medium">{c.type} <Badge variant={c.status === "COMPLETED" ? "default" : "secondary"}>{c.status}</Badge></p>
              <ul className="space-y-1">
                {c.items.map((it) => (
                  <li key={it.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={it.done} onChange={(e) => post(`hr/staff/checklist-items/${it.id}/toggle`, { done: e.target.checked }, it.id)} />
                    <span className={it.done ? "text-muted-foreground line-through" : ""}>{it.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      <DocumentsSection userId={userId} documents={documents} post={post} busy={busy} />
      <TrainingSection userId={userId} training={training} post={post} busy={busy} />
    </div>
  );
}

function DocumentsSection({ userId, documents, post, busy }: { userId: string; documents: Doc[]; post: (p: string, b: unknown, k: string) => Promise<boolean>; busy: string | null }) {
  const [kind, setKind] = React.useState<(typeof DOC_KINDS)[number]>("CONTRACT");
  const [name, setName] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;
    const ok = await post(`hr/staff/${userId}/documents`, { kind, name, expiresAt: expiresAt || null }, "doc");
    if (ok) { setName(""); setExpiresAt(""); }
  };
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Documents &amp; expiry</CardTitle>
        <Button size="sm" variant="outline" disabled={busy === "rem"} onClick={() => post("hr/staff/documents/reminders/run", {}, "rem")}>Run expiry reminders</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="doc-kind">Kind</Label>
            <select id="doc-kind" value={kind} onChange={(e) => setKind(e.target.value as (typeof DOC_KINDS)[number])} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              {DOC_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ").toLowerCase()}</option>)}
            </select>
          </div>
          <div className="space-y-1.5 flex-1 min-w-40"><Label htmlFor="doc-name">Name</Label><Input id="doc-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="doc-exp">Expires</Label><Input id="doc-exp" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></div>
          <Button type="submit" disabled={busy === "doc"}>Add</Button>
        </form>
        {documents.length === 0 ? <p className="text-sm text-muted-foreground">No documents.</p> : (
          <ul className="space-y-1 text-sm">
            {documents.map((d) => (
              <li key={d.id} className="flex justify-between">
                <span>{d.kind.replace(/_/g, " ").toLowerCase()} · {d.name}</span>
                <span className={d.daysUntilExpiry != null && d.daysUntilExpiry < 30 ? "text-destructive" : "text-muted-foreground"}>
                  {d.expiresAt ? `expires ${d.expiresAt.slice(0, 10)}${d.daysUntilExpiry != null ? ` (${d.daysUntilExpiry}d)` : ""}` : "no expiry"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TrainingSection({ userId, training, post, busy }: { userId: string; training: Training[]; post: (p: string, b: unknown, k: string) => Promise<boolean>; busy: string | null }) {
  const [title, setTitle] = React.useState("");
  const [provider, setProvider] = React.useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title) return;
    const ok = await post(`hr/staff/${userId}/training`, { title, provider: provider || null }, "trn");
    if (ok) { setTitle(""); setProvider(""); }
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Training &amp; certifications</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5 flex-1 min-w-40"><Label htmlFor="trn-title">Title</Label><Input id="trn-title" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="trn-prov">Provider</Label><Input id="trn-prov" value={provider} onChange={(e) => setProvider(e.target.value)} /></div>
          <Button type="submit" disabled={busy === "trn"}>Add</Button>
        </form>
        {training.length === 0 ? <p className="text-sm text-muted-foreground">No training records.</p> : (
          <ul className="space-y-1 text-sm">
            {training.map((t) => (
              <li key={t.id} className="flex justify-between">
                <span>{t.title}{t.provider ? ` · ${t.provider}` : ""}</span>
                <Badge variant={t.status === "COMPLETED" ? "default" : "secondary"}>{t.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
