"use client";

// Certificate / ID-card issuer. Staff pick a person + type and download the
// generated PDF (the POST streams a PDF, so we fetch as a blob and save it).

import * as React from "react";

import { useFormat } from "@/components/shell/RegionProvider";
// /certificates/history/:subjectId existed with no screen, so a clerk could
// issue a duplicate certificate to the same pupil with nothing to warn them.
type Issued = { id: string; type: string; title: string | null; serial: string; issuedAt: string };
import { StudentPicker } from "@/components/people/StudentPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { personLabel } from "@/lib/people";

type Person = { id: string; name: string; roles?: string[] };

export function CertificateIssuer({ staff, students = [] }: { staff: Person[]; students?: Person[] }) {
  // Dates follow the SCHOOL's calendar, not the browser's.
  const { shortDate } = useFormat();
  const [type, setType] = React.useState("ID_CARD");
  // Categorised person picker: choose Student or Staff, then a name from ONLY
  // that list (defaults to students — the overwhelmingly common case).
  const [category, setCategory] = React.useState<"STUDENT" | "STAFF">("STUDENT");
  const people = category === "STUDENT" ? students : staff;
  const [subjectId, setSubjectId] = React.useState(students[0]?.id ?? "");
  const [history, setHistory] = React.useState<Issued[]>([]);
  React.useEffect(() => {
    if (!subjectId) return void setHistory([]);
    let live = true;
    void (async () => {
      const r = await fetch(`/api/sms/certificates/history/${subjectId}`);
      if (live && r.ok) setHistory((await r.json()) as Issued[]);
    })();
    return () => {
      live = false;
    };
  }, [subjectId]);
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
    if (!res.ok) { setMsg(await readApiError(res)); return; }
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
            <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="ID_CARD">ID card</option>
              <option value="COMPLETION">Completion certificate</option>
              <option value="PARTICIPATION">Participation</option>
              <option value="MERIT">Merit award</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>For</Label>
            <select aria-label="Category"
              value={category}
              onChange={(e) => {
                const c = e.target.value as "STUDENT" | "STAFF";
                setCategory(c);
                setSubjectId((c === "STUDENT" ? students : staff)[0]?.id ?? "");
              }}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="STUDENT">Student</option>
              <option value="STAFF">Staff</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Person</Label>
            {/* Students are searched (the roster no longer arrives whole); staff is a
                short list, so it stays a plain select. */}
            {category === "STUDENT" ? (
              <StudentPicker value={subjectId} onChange={setSubjectId} seed={students} />
            ) : (
              <select aria-label="Subject" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {people.map((u) => <option key={u.id} value={u.id}>{personLabel(u)}</option>)}
              </select>
            )}
          </div>
          <Button disabled={busy || !subjectId} onClick={issue}>{busy ? "Generating…" : "Generate PDF"}</Button>
        </div>
        {type !== "ID_CARD" && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label>Title (optional)</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Certificate of Completion" /></div>
            <div className="space-y-1.5 flex-1 min-w-60"><Label>Body (optional)</Label><Input value={body} onChange={(e) => setBody(e.target.value)} placeholder="has successfully completed…" /></div>
          </div>
        )}

        {/* Already issued to this person. Shown BEFORE the issue button is
            pressed, because the point is to prevent the duplicate, not to
            explain it afterwards. */}
        {history.length > 0 && (
          <div className="mt-3 rounded-md border border-border bg-muted/40 p-2">
            <div className="mb-1 text-xs font-medium">
              Already issued to this person ({history.length})
            </div>
            <ul className="space-y-0.5">
              {history.slice(0, 6).map((h) => (
                <li key={h.id} className="text-xs text-muted-foreground">
                  {h.title || h.type} · {h.serial} · {shortDate(h.issuedAt)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
