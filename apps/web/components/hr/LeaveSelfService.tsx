"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { LeaveBalanceDto, LeaveRequestDto, LeaveTypeDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { fileToBase64, MAX_VAULT_BYTES } from "@/lib/vault-upload";

type Type = Serialized<LeaveTypeDto>;
type Balance = Serialized<LeaveBalanceDto>;
type Request = Serialized<LeaveRequestDto>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "secondary",
  APPROVED: "default",
  REJECTED: "destructive",
  CANCELLED: "outline",
};

function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return ms < 0 ? 0 : Math.round(ms / 86_400_000) + 1;
}

export function LeaveSelfService({
  types,
  balances,
  requests,
  selfUserId,
}: {
  types: Type[];
  balances: Balance[];
  requests: Request[];
  /** The signed-in staff member. An attachment is a document about THEM, and
   *  the API refuses one about anybody else. */
  selfUserId: string;
}) {
  const router = useRouter();
  const [leaveTypeId, setLeaveTypeId] = React.useState(types[0]?.id ?? "");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [halfDay, setHalfDay] = React.useState(false);
  // THE EVIDENCE FOR THE REQUEST — a sick note, a doctor's report, a certificate.
  //
  // The API has accepted `attachmentDocId` since the leave module shipped and
  // no screen sent one. It could not: the attachment must be a Vault document
  // the CALLER uploaded, and the Vault refused a non-student document from
  // anyone who was not school-wide — which is most of the people who take
  // leave. A staff member may now upload a document ABOUT THEMSELVES, readable
  // by the principal, HR and the school administrator, so this works for the
  // teacher it was always meant for.
  const [file, setFile] = React.useState<File | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const effectiveEnd = halfDay ? startDate : endDate;
  const days = halfDay ? 0.5 : startDate && endDate ? daysBetween(startDate, endDate) : 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leaveTypeId || !startDate || !effectiveEnd || days < 0.5) return;
    setBusy(true);
    setMsg(null);
    // The document goes to the Vault FIRST, because the API only accepts an
    // attachment the CALLER uploaded — it checks `uploadedById`, so a request
    // can never point at somebody else's file. Two steps, the same pair the
    // Documents page uses: metadata, then the bytes.
    let attachmentDocId: string | null = null;
    if (file) {
      if (file.size > MAX_VAULT_BYTES) {
        setBusy(false);
        setMsg("That file is larger than 10 MB.");
        return;
      }
      setMsg("Uploading the attachment…");
      const meta = await fetch("/api/sms/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // ABOUT ME. This is what the Vault now understands and what makes the
          // whole attachment possible; it is also what limits who can read it.
          staffUserId: selfUserId,
          type: "OTHER",
          title: `Leave attachment — ${file.name}`.slice(0, 200),
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        }),
      });
      if (!meta.ok) {
        setBusy(false);
        setMsg(await readApiError(meta));
        return;
      }
      const { document } = (await meta.json()) as { document: { id: string } };
      const bytes = await fetch(`/api/sms/documents/${document.id}/upload-bytes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataBase64: await fileToBase64(file),
          contentType: file.type || "application/octet-stream",
        }),
      });
      if (!bytes.ok) {
        // NOT sent without it. A request that silently drops the evidence is
        // worse than one that fails: the approver would decide on less than the
        // person asking believed they had supplied.
        setBusy(false);
        setMsg(await readApiError(bytes));
        return;
      }
      attachmentDocId = document.id;
    }
    const res = await fetch("/api/sms/hr/leave/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaveTypeId, startDate, endDate: effectiveEnd, days, reason: reason || null, attachmentDocId }),
    });
    setBusy(false);
    if (res.ok) {
      setStartDate("");
      setEndDate("");
      setReason("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setMsg("Submitted — routed to your head, then HR, then the principal.");
      router.refresh();
    } else {
      setMsg(await readApiError(res));
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {balances.map((b) => (
          <Card key={b.id}>
            <CardHeader className="pb-2"><CardTitle className="text-sm">{b.leaveTypeName}</CardTitle></CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{b.remainingDays}<span className="text-sm font-normal text-muted-foreground"> / {b.entitledDays} days left</span></p>
              <p className="text-xs text-muted-foreground">{b.usedDays} used in {b.year}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Apply for leave</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="lv-type">Type</Label>
              <select id="lv-type" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5"><Label htmlFor="lv-start">{halfDay ? "Date" : "From"}</Label><Input id="lv-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
            {!halfDay && (
              <div className="space-y-1.5"><Label htmlFor="lv-end">To</Label><Input id="lv-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
            )}
            <label className="flex h-9 items-center gap-1.5 text-sm">
              <input type="checkbox" checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)} /> Half day
            </label>
            <div className="space-y-1.5 flex-1 min-w-40"><Label htmlFor="lv-reason">Reason</Label><Input id="lv-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" /></div>
          <div className="space-y-1.5 min-w-56">
            <Label htmlFor="lv-doc">Supporting document <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <input
              id="lv-doc"
              ref={fileRef}
              type="file"
              aria-label="Supporting document for this leave request"
              className="block w-full text-sm file:mr-2 file:rounded-md file:border file:border-border file:bg-muted file:px-2 file:py-1 file:text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">
              A sick note, a doctor&apos;s report or a certificate. Only you and the people who decide
              your request — your head teacher, HR, the school administrator and the principal — can
              open it.
            </p>
          </div>

            <Button type="submit" disabled={busy || days < 1}>{busy ? "Submitting…" : days > 0 ? `Apply (${days}d)` : "Apply"}</Button>
            {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">My leave requests</CardTitle></CardHeader>
        <CardContent className="p-0">
          {requests.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-muted-foreground">
                <tr><th className="px-4 py-2.5 font-medium">Type</th><th className="px-4 py-2.5 font-medium">Dates</th><th className="px-4 py-2.5 font-medium">Days</th><th className="px-4 py-2.5 font-medium">Status</th></tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5">{r.leaveTypeName ?? "—"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.startDate.slice(0, 10)} → {r.endDate.slice(0, 10)}</td>
                    <td className="px-4 py-2.5">{r.days}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant={STATUS_VARIANT[r.status] ?? "secondary"}>{r.status}</Badge>
                      {/* The attachment has been on the DTO since the module
                          shipped and no screen read it, so evidence supplied
                          through the API was invisible to everyone including
                          the approver. The BFF is binary-aware, so this is a
                          plain link to the signed download. */}
                      {r.attachmentDocId && (
                        <a
                          className="ml-2 text-xs text-primary underline-offset-2 hover:underline"
                          href={`/api/sms/documents/${r.attachmentDocId}/file`}
                        >
                          attachment
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
