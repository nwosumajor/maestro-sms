"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { money } from "@/lib/format";

interface Student { id: string; name: string }
interface FeeItem { id: string; name: string; amountMinor: number; currency: string }
interface Line { description: string; amountMajor: string; quantity: number }

const toMinor = (major: string) => Math.round(parseFloat(major || "0") * 100);

export function FeesAdmin({ students, items }: { students: Student[]; items: FeeItem[] }) {
  const router = useRouter();
  const [tab, setTab] = React.useState<"invoice" | "catalog">("invoice");

  // --- new invoice ---
  const [studentId, setStudentId] = React.useState(students[0]?.id ?? "");
  const [dueDate, setDueDate] = React.useState("");
  const [lines, setLines] = React.useState<Line[]>([{ description: "", amountMajor: "", quantity: 1 }]);
  const [invBusy, setInvBusy] = React.useState(false);
  const [invMsg, setInvMsg] = React.useState<string | null>(null);

  const total = lines.reduce((n, l) => n + toMinor(l.amountMajor) * l.quantity, 0);
  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((xs) => xs.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const prefill = (i: number, itemId: string) => {
    const it = items.find((x) => x.id === itemId);
    if (it) setLine(i, { description: it.name, amountMajor: (it.amountMinor / 100).toFixed(2) });
  };

  const createInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!studentId || !dueDate) { setInvMsg("Pick a student and due date."); return; }
    setInvBusy(true); setInvMsg(null);
    const res = await fetch("/api/sms/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId,
        dueDate,
        lines: lines
          .filter((l) => l.description && toMinor(l.amountMajor) > 0)
          .map((l) => ({ description: l.description, amountMinor: toMinor(l.amountMajor), quantity: l.quantity })),
      }),
    });
    setInvBusy(false);
    if (!res.ok) { setInvMsg(`Failed (${res.status}).`); return; }
    setInvMsg("Invoice created as DRAFT. Open it to issue.");
    setLines([{ description: "", amountMajor: "", quantity: 1 }]);
    router.refresh();
  };

  // --- new fee item ---
  const [fiName, setFiName] = React.useState("");
  const [fiAmount, setFiAmount] = React.useState("");
  const [fiBusy, setFiBusy] = React.useState(false);

  const createItem = async (e: React.FormEvent) => {
    e.preventDefault();
    setFiBusy(true);
    const res = await fetch("/api/sms/fees/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: fiName, amountMinor: toMinor(fiAmount) }),
    });
    setFiBusy(false);
    if (res.ok) { setFiName(""); setFiAmount(""); router.refresh(); }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <button onClick={() => setTab("invoice")} className={tabCls(tab === "invoice")}>New invoice</button>
          <button onClick={() => setTab("catalog")} className={tabCls(tab === "catalog")}>Fee catalog</button>
        </div>
        <CardDescription>
          {tab === "invoice" ? "Bill a student. The invoice starts as a draft." : "Reusable fee items to prefill invoice lines."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {tab === "invoice" ? (
          <form onSubmit={createInvoice} className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="space-y-1.5">
                <Label htmlFor="inv-student">Student</Label>
                <select id="inv-student" value={studentId} onChange={(e) => setStudentId(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-56">
                  {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inv-due">Due date</Label>
                <Input id="inv-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-44" />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Line items</Label>
              {lines.map((l, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  {items.length > 0 && (
                    <select onChange={(e) => prefill(i, e.target.value)} defaultValue=""
                      className="h-9 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground">
                      <option value="" disabled>From catalog…</option>
                      {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                    </select>
                  )}
                  <Input placeholder="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} className="min-w-[10rem] flex-1" />
                  <Input placeholder="Amount" inputMode="decimal" value={l.amountMajor} onChange={(e) => setLine(i, { amountMajor: e.target.value })} className="w-28" />
                  <Input type="number" min={1} value={l.quantity} onChange={(e) => setLine(i, { quantity: Math.max(1, Number(e.target.value)) })} className="w-16" />
                  {lines.length > 1 && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setLines((xs) => xs.filter((_, idx) => idx !== i))}>✕</Button>
                  )}
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" onClick={() => setLines((xs) => [...xs, { description: "", amountMajor: "", quantity: 1 }])}>
                + Add line
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total: <strong>{money(total)}</strong></span>
              <Button type="submit" disabled={invBusy}>{invBusy ? "Creating…" : "Create invoice"}</Button>
            </div>
            {invMsg && <p className="text-sm text-muted-foreground">{invMsg}</p>}
          </form>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">No fee items yet.</p>
              ) : (
                items.map((it) => (
                  <div key={it.id} className="flex items-center justify-between border-b border-border py-1.5 text-sm last:border-0">
                    <span>{it.name}</span>
                    <span className="text-muted-foreground">{money(it.amountMinor, it.currency)}</span>
                  </div>
                ))
              )}
            </div>
            <form onSubmit={createItem} className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="fi-name">Name</Label>
                <Input id="fi-name" value={fiName} onChange={(e) => setFiName(e.target.value)} placeholder="Tuition — Term 1" className="w-56" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fi-amount">Amount (₦)</Label>
                <Input id="fi-amount" inputMode="decimal" value={fiAmount} onChange={(e) => setFiAmount(e.target.value)} className="w-32" required />
              </div>
              <Button type="submit" disabled={fiBusy}>{fiBusy ? "Adding…" : "Add item"}</Button>
            </form>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function tabCls(active: boolean) {
  return (
    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
    (active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")
  );
}
