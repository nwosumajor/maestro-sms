"use client";

// Library Management UI. Librarians (canManage) maintain the barcode catalogue,
// issue/return for anyone, view fines, and export CSV. Students search and self-
// issue/renew/return their own loans from the same screen.

import type { LibraryBookDto, BookLoanDto, LibraryBorrowerDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms, sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { useFormat } from "@/components/shell/RegionProvider";

type Book = Serialized<LibraryBookDto>;
type Loan = Serialized<BookLoanDto>;
type Borrower = Serialized<LibraryBorrowerDto>;

export function LibraryManager({
  books, loans, apiBaseUrl, canManage,
}: {
  books: Book[]; loans: Loan[]; apiBaseUrl: string; canManage: boolean;
}) {
  // The SCHOOL's currency, not the platform's. `money` from `@/lib/format`
  // defaults to `PLATFORM_REGION.currency`, so these read in naira for a school
  // that bills in anything else — the region rides the session and
  // `useFormat()` is how a client island gets at it.
  const { money, shortDate } = useFormat();
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [q, setQ] = React.useState("");
  // WHO THE BOOK IS FOR. `issue` has always accepted a borrower — "librarians to
  // anyone, students to themselves" — and the only control here was "Issue to
  // me", so a librarian could not lend a book to a pupil through the product at
  // all. Nothing about the server needed changing; the desk had no way to name
  // the person.
  const [borrowerQ, setBorrowerQ] = React.useState("");
  const [borrowers, setBorrowers] = React.useState<Borrower[]>([]);
  const [borrower, setBorrower] = React.useState<Borrower | null>(null);
  const [lookingUp, setLookingUp] = React.useState(false);
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

  // Searched, never a whole-school scroll. The server caps it too — a picker
  // that lists nine hundred pupils is one nobody can use.
  const findBorrowers = async () => {
    setLookingUp(true);
    const res = await fetch(`/api/sms/library/borrowers?q=${encodeURIComponent(borrowerQ.trim())}`);
    setLookingUp(false);
    if (!res.ok) {
      // A failed lookup must not read as "nobody by that name" — that would send
      // a librarian looking for a pupil who is right there.
      setBorrowers([]);
      setMsg("The borrower list could not be loaded. Nobody has been ruled out — try again.");
      return;
    }
    setBorrowers((await res.json()) as Borrower[]);
  };

  const issueTo = (bookId: string) =>
    run(
      () => postSms("library/loans/issue", borrower ? { bookId, borrowerId: borrower.id } : { bookId }),
      borrower ? `Issued to ${borrower.name}.` : "Issued to you.",
    );

  const shown = q.trim()
    ? books.filter((b) => [b.title, b.author, b.isbn, b.barcode].some((f) => (f ?? "").toLowerCase().includes(q.trim().toLowerCase())))
    : books;

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {/* WHO THE BOOK IS FOR. Only a librarian may lend to somebody else, and
          only a librarian can reach the lookup behind this — `library.manage`
          on both halves, so the control and the route agree. Without it the
          desk could only ever lend to the person signed in. */}
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Who is borrowing?</CardTitle>
            <CardDescription>
              Find the pupil or member of staff first, then issue from the catalogue below. Leave this
              empty to borrow a book yourself.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {borrower ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  {borrower.name}
                  {borrower.admissionNo ? ` · ${borrower.admissionNo}` : ""}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setBorrower(null); setBorrowers([]); setBorrowerQ(""); }}
                >
                  Clear — borrow for myself
                </Button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="lib-borrower">Name</Label>
                    <Input
                      id="lib-borrower"
                      value={borrowerQ}
                      onChange={(e) => setBorrowerQ(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void findBorrowers(); } }}
                      placeholder="Start typing a name…"
                    />
                  </div>
                  <Button variant="outline" size="sm" disabled={lookingUp} onClick={() => void findBorrowers()}>
                    {lookingUp ? "Looking…" : "Find"}
                  </Button>
                </div>
                {borrowers.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {borrowers.map((b) => (
                      <Button
                        key={b.id}
                        variant="ghost"
                        size="sm"
                        aria-label={`Issue to ${b.name}`}
                        onClick={() => setBorrower(b)}
                      >
                        {b.name}
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {/* The admission number, because two pupils sharing a
                              name is ordinary and the wrong pick puts a book on
                              the wrong child's record. */}
                          {b.admissionNo ?? (b.kind === "STAFF" ? "staff" : "—")}
                        </span>
                      </Button>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

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
                      <Button variant="outline" size="sm" disabled={busy || b.availableCopies < 1} onClick={() => void issueTo(b.id)}>
                        {borrower ? `Issue to ${borrower.name.split(" ")[0]}` : "Issue to me"}
                      </Button>
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
                          {/* Library staff only: a return records that the book
                              is physically back on the shelf. A borrower can
                              renew from here, but hands the book in at the desk. */}
                          {canManage && (
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`library/loans/${l.id}/return`, {}), "Returned.")}>Return</Button>
                          )}
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
