"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ApplicantDto, JobRequisitionDto, Serialized } from "@sms/types";
import { postWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Req = Serialized<JobRequisitionDto>;
type Applicant = Serialized<ApplicantDto>;

const STAGES = ["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"] as const;

export function RecruitmentManager({ requisitions, applicants }: { requisitions: Req[]; applicants: Applicant[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState("");
  const [dept, setDept] = React.useState("");

  const post = async (path: string, body: unknown, key: string) => {
    setBusy(key);
    const res = await fetch(`/api/sms/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(null);
    if (res.ok) router.refresh();
    return res.ok;
  };

  const createReq = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title) return;
    const ok = await post("hr/recruitment/requisitions", { title, department: dept || null }, "req");
    if (ok) { setTitle(""); setDept(""); }
  };

  const convert = async (id: string) => {
    setBusy(id);
    setMsg(null);
    const res = await postWithStepUp(`hr/recruitment/applicants/${id}/convert`, {});
    setBusy(null);
    if (res.ok) {
      const d = (await res.json()) as { email: string; tempPassword: string };
      setMsg(`Hired ${d.email} — temporary password: ${d.tempPassword}`);
      router.refresh();
    } else setMsg(await readApiError(res));
  };

  const applicantsByReq = (reqId: string) => applicants.filter((a) => a.requisitionId === reqId);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-base">Open a requisition</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={createReq} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5 flex-1 min-w-40"><Label htmlFor="rq-title">Title</Label><Input id="rq-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Mathematics Teacher" /></div>
            <div className="space-y-1.5"><Label htmlFor="rq-dept">Department</Label><Input id="rq-dept" value={dept} onChange={(e) => setDept(e.target.value)} /></div>
            <Button type="submit" disabled={busy === "req"}>Create</Button>
          </form>
          {msg && <p className="mt-3 rounded-md bg-muted px-3 py-2 text-sm font-mono">{msg}</p>}
        </CardContent>
      </Card>

      {requisitions.length === 0 ? <p className="text-sm text-muted-foreground">No requisitions yet.</p> : requisitions.map((r) => (
        <Card key={r.id}>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">{r.title}{r.department ? ` · ${r.department}` : ""} <Badge variant={r.status === "OPEN" ? "default" : "outline"}>{r.status}</Badge></CardTitle>
            <ApplicantForm reqId={r.id} post={post} busy={busy} />
          </CardHeader>
          <CardContent>
            {applicantsByReq(r.id).length === 0 ? <p className="text-sm text-muted-foreground">No applicants.</p> : (
              <table className="w-full text-sm">
                <tbody>
                  {applicantsByReq(r.id).map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-0">
                      <td className="py-2">{a.name} <span className="text-muted-foreground">{a.email}</span></td>
                      <td className="py-2">
                        <select value={a.stage} disabled={!!a.convertedUserId} onChange={(e) => post(`hr/recruitment/applicants/${a.id}/stage`, { stage: e.target.value }, a.id)} className="h-8 rounded-md border border-input bg-background px-2 text-sm">
                          {STAGES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
                        </select>
                      </td>
                      <td className="py-2 text-right">
                        {a.convertedUserId ? <Badge variant="secondary">staff account created</Badge> : (
                          <Button size="sm" variant="outline" disabled={busy === a.id} onClick={() => convert(a.id)}>Hire → staff</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ApplicantForm({ reqId, post, busy }: { reqId: string; post: (p: string, b: unknown, k: string) => Promise<boolean>; busy: string | null }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email) return;
    const ok = await post(`hr/recruitment/requisitions/${reqId}/applicants`, { name, email }, `ap-${reqId}`);
    if (ok) { setName(""); setEmail(""); }
  };
  return (
    <form onSubmit={add} className="flex items-end gap-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Applicant" className="h-8 w-32" />
      <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" className="h-8 w-40" />
      <Button type="submit" size="sm" variant="outline" disabled={busy === `ap-${reqId}`}>Add</Button>
    </form>
  );
}
