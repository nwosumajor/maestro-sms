"use client";

// Certificate / ID-card issuer. Staff pick a person + type and download the
// generated PDF (the POST streams a PDF, so we fetch as a blob and save it).

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Person = { id: string; name: string };

export function CertificateIssuer({ people }: { people: Person[] }) {
  const [type, setType] = React.useState("ID_CARD");
  const [subjectId, setSubjectId] = React.useState(people[0]?.id ?? "");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const issue = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/certificates/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, subjectId, title: title || undefined, body: body || undefined }),
    });
    setBusy(false);
    if (!res.ok) { setMsg(`Failed (${res.status}).`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type.toLowerCase()}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg("Issued — PDF downloaded.");
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Issue a certificate or ID card</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <select value={type} onChange={(e) => setType(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="ID_CARD">ID card</option>
              <option value="COMPLETION">Completion certificate</option>
              <option value="PARTICIPATION">Participation</option>
              <option value="MERIT">Merit award</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Person</Label>
            <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <Button disabled={busy || !subjectId} onClick={issue}>{busy ? "Generating…" : "Generate PDF"}</Button>
        </div>
        {type !== "ID_CARD" && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label>Title (optional)</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Certificate of Completion" /></div>
            <div className="space-y-1.5 flex-1 min-w-60"><Label>Body (optional)</Label><Input value={body} onChange={(e) => setBody(e.target.value)} placeholder="has successfully completed…" /></div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
