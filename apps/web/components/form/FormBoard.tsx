"use client";

// Form Builder UI. Staff build a simple form (add fields), set audience +
// anonymity, and view responses. Members fill in open forms in their audience.

import type { FormDto, FormFieldDef, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Form = Serialized<FormDto>;

export function FormBoard({ forms, canManage }: { forms: Form[]; canManage: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [audience, setAudience] = React.useState("ALL");
  const [anon, setAnon] = React.useState(false);
  const [fields, setFields] = React.useState<FormFieldDef[]>([{ key: "q1", label: "", type: "text", required: true }]);
  const [answers, setAnswers] = React.useState<Record<string, Record<string, string>>>({});

  const run = async (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) { setMsg(ok); router.refresh(); } else setMsg(res.error ?? `Failed (${res.status}).`);
  };

  const addField = () => setFields((f) => [...f, { key: `q${f.length + 1}`, label: "", type: "text", required: false }]);
  const setField = (i: number, patch: Partial<FormFieldDef>) => setFields((f) => f.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {canManage && (
        <Card>
          <CardHeader><CardTitle className="text-base">Build a form</CardTitle><CardDescription>Surveys, feedback, or review templates.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5 flex-1 min-w-60"><Label>Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
              <div className="space-y-1.5">
                <Label>Audience</Label>
                <select value={audience} onChange={(e) => setAudience(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="ALL">Everyone</option><option value="STUDENTS">Students</option><option value="STAFF">Staff</option>
                </select>
              </div>
              <label className="flex items-center gap-1.5 text-sm pb-2"><input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} />Anonymous</label>
            </div>
            <div className="space-y-2">
              <Label>Fields</Label>
              {fields.map((f, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <Input value={f.label} onChange={(e) => setField(i, { label: e.target.value })} placeholder={`Question ${i + 1}`} className="flex-1 min-w-48" />
                  <select value={f.type} onChange={(e) => setField(i, { type: e.target.value })} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                    <option value="text">Text</option><option value="textarea">Long text</option><option value="number">Number</option><option value="rating">Rating</option>
                  </select>
                  <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.required ?? false} onChange={(e) => setField(i, { required: e.target.checked })} />required</label>
                </div>
              ))}
              <Button variant="outline" size="sm" type="button" onClick={addField}>+ Add field</Button>
            </div>
            <Button disabled={busy || !title || fields.some((f) => !f.label)} onClick={() => run(() => postSms("forms", { title, audience, anonymous: anon, fields: fields.map((f, i) => ({ ...f, key: `q${i + 1}` })) }), "Form created.").then(() => { setTitle(""); setFields([{ key: "q1", label: "", type: "text", required: true }]); })}>Create form</Button>
          </CardContent>
        </Card>
      )}

      {forms.length === 0 && <p className="text-sm text-muted-foreground">No forms.</p>}

      {forms.map((form) => (
        <Card key={form.id}>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {form.title}
              <Badge variant={form.status === "CLOSED" ? "outline" : "secondary"}>{form.status}</Badge>
              <Badge variant="outline" className="font-normal">{form.audience}</Badge>
              {form.anonymous && <Badge variant="outline" className="font-normal">anonymous</Badge>}
            </CardTitle>
            <CardDescription>By {form.createdByName} · {form.responseCount} response{form.responseCount === 1 ? "" : "s"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {!form.hasResponded && form.status === "OPEN" && !canManage && (
              <div className="space-y-2">
                {form.fields.map((fl) => (
                  <div key={fl.key} className="space-y-1">
                    <Label>{fl.label}{fl.required ? " *" : ""}</Label>
                    <Input
                      type={fl.type === "number" || fl.type === "rating" ? "number" : "text"}
                      value={answers[form.id]?.[fl.key] ?? ""}
                      onChange={(e) => setAnswers((a) => ({ ...a, [form.id]: { ...a[form.id], [fl.key]: e.target.value } }))}
                    />
                  </div>
                ))}
                <Button size="sm" disabled={busy} onClick={() => run(() => postSms(`forms/${form.id}/respond`, { answers: answers[form.id] ?? {} }), "Response submitted.")}>Submit</Button>
              </div>
            )}
            {form.hasResponded && <p className="text-xs text-muted-foreground">You have responded.</p>}
            {canManage && (
              <div className="flex gap-2">
                <a href={`/api/sms/forms/${form.id}/responses`} target="_blank" rel="noreferrer"><Button variant="outline" size="sm" type="button">View responses (JSON)</Button></a>
                {form.status === "OPEN" && <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`forms/${form.id}/close`, {}), "Closed.")}>Close</Button>}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
