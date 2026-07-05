"use client";

// Library Management UI. Librarians (canManage) maintain the barcode catalogue,
// issue/return for anyone, view fines, and export CSV. Students search and self-
// issue/renew/return their own loans from the same screen.

import type { LibraryBookDto, BookLoanDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms, sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money, shortDate } from "@/lib/format";

type Book = Serialized<LibraryBookDto>;
type Loan = Serialized<BookLoanDto>;

export function LibraryManager({
  books, loans, apiBaseUrl, canManage,
}: {
  books: Book[]; loans: Loan[]; apiBaseUrl: string; canManage: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [q, setQ] = React.useState("");
  // new book
  const [bTitle, setBTitle] = React.useState("");
  const [bBarcode, setBBarcode] = React.useState("");
  const [bCopies, setBCopies] = React.useState(1);

  const run = async (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) { setMsg(ok); router.refresh(); } else setMsg(res.error ?? "Request failed.");
  };

  const shown = q.trim()
    ? books.filter((b) => [b.title, b.author, b.isbn, b.barcode].some((f) => (f ?? "").toLowerCase().includes(q.trim().toLowerCase())))
    : books;

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Search the catalogue</CardTitle>
          <CardDescription>By title, author, ISBN, or barcode.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Scan barcode or type a title…" />
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1 pr-3 font-medium">Title</th><th className="py-1 pr-3 font-medium">Author</th>
              <th className="py-1 pr-3 font-medium">Barcode</th><th className="py-1 pr-3 font-medium">Available</th>
              <th className="py-1 font-medium"></th>
            </tr></thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id} className="border-b border-border/50">
                  <td className="py-1 pr-3">{b.title}</td><td className="py-1 pr-3">{b.author ?? "—"}</td>
                  <td className="py-1 pr-3 font-mono text-xs">{b.barcode}</td>
                  <td className="py-1 pr-3"><Badge variant={b.availableCopies > 0 ? "secondary" : "outline"}>{b.availableCopies}/{b.totalCopies}</Badge></td>
                  <td className="py-1">
                    <div className="flex gap-1.5">
                      <Button variant="outline" size="sm" disabled={busy || b.availableCopies < 1} onClick={() => run(() => postSms("library/loans/issue", { bookId: b.id }), "Issued to you.")}>Issue to me</Button>
                      {canManage && (
                        <>
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
                            const name = prompt("New title for this book?", b.title);
                            if (name?.trim()) void run(() => sendSms("PUT", `library/books/${b.id}`, { title: name.trim() }), "Book renamed.");
                          }}>Rename</Button>
                          <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => {
                            if (!confirm(`Delete "${b.title}"? Only possible if it has never been loaned.`)) return;
                            void run(() => sendSms("DELETE", `library/books/${b.id}`), "Book deleted.");
                          }}>Delete</Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader><CardTitle className="text-base">Add a book</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label>Title</Label><Input value={bTitle} onChange={(e) => setBTitle(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Barcode</Label><Input value={bBarcode} onChange={(e) => setBBarcode(e.target.value)} placeholder="scan…" /></div>
            <div className="space-y-1.5"><Label>Copies</Label><Input className="w-20" type="number" min={1} value={bCopies} onChange={(e) => setBCopies(Number(e.target.value))} /></div>
            <Button disabled={busy || !bTitle || !bBarcode} onClick={() => run(() => postSms("library/books", { title: bTitle, barcode: bBarcode, totalCopies: bCopies }), "Book added.")}>Add</Button>
            <a href={`${apiBaseUrl.replace(/\/$/, "")}/library/books/export.csv`} className="ml-auto"><Button variant="outline" type="button">Export CSV</Button></a>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">{canManage ? "Loans" : "My loans"}</CardTitle></CardHeader>
        <CardContent>
          {loans.length === 0 ? (
            <p className="text-sm text-muted-foreground">No loans.</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Book</th>{canManage && <th className="py-1 pr-3 font-medium">Borrower</th>}
                <th className="py-1 pr-3 font-medium">Due</th><th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">Fine</th><th className="py-1 font-medium"></th>
              </tr></thead>
              <tbody>
                {loans.map((l) => (
                  <tr key={l.id} className="border-b border-border/50">
                    <td className="py-1 pr-3">{l.bookTitle}</td>{canManage && <td className="py-1 pr-3">{l.borrowerName}</td>}
                    <td className="py-1 pr-3">{shortDate(l.dueAt)}</td>
                    <td className="py-1 pr-3"><Badge variant={l.overdue ? "destructive" : l.status === "RETURNED" ? "outline" : "secondary"}>{l.overdue ? "OVERDUE" : l.status}</Badge></td>
                    <td className="py-1 pr-3">{l.fineMinor > 0 ? `${money(l.fineMinor)}${l.finePaid ? " (paid)" : ""}` : "—"}</td>
                    <td className="py-1">
                      {l.status === "ISSUED" && (
                        <span className="flex gap-1">
                          <Button variant="outline" size="sm" disabled={busy || l.renewedCount >= 2} onClick={() => run(() => postSms(`library/loans/${l.id}/renew`, {}), "Renewed.")}>Renew</Button>
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`library/loans/${l.id}/return`, {}), "Returned.")}>Return</Button>
                        </span>
                      )}
                      {canManage && l.fineMinor > 0 && !l.finePaid && (
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`library/loans/${l.id}/pay-fine`, {}), "Fine receipt issued.")}>Pay fine</Button>
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
