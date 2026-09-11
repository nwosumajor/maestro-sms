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

/** One page of a list, plus how many there are in all. */
type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

/**
 * What is shown, out of what there is.
 *
 * ONE control for both lists. A screenful with no number reads as the whole
 * thing — which is how a librarian came to believe their school held 200 books
 * and had 14 overdue loans.
 */
function Pager({ p, onPage, noun }: { p: Page<unknown>; onPage: (n: number) => void; noun: string }) {
  if (p.total <= p.pageSize) return null;
  const pages = Math.max(1, Math.ceil(p.total / p.pageSize));
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
      <span>
        Showing {(p.page - 1) * p.pageSize + 1}&ndash;{Math.min(p.page * p.pageSize, p.total)} of {p.total} {noun}
      </span>
      <span className="flex items-center gap-3">
        <button type="button" disabled={p.page <= 1} onClick={() => onPage(Math.max(1, p.page - 1))}
          className="underline underline-offset-2 disabled:no-underline disabled:opacity-40">Previous</button>
        <span>Page {p.page} of {pages}</span>
        <button type="button" disabled={p.page * p.pageSize >= p.total} onClick={() => onPage(p.page + 1)}
          className="underline underline-offset-2 disabled:no-underline disabled:opacity-40">Next</button>
      </span>
    </div>
  );
}

export function LibraryManager({
  books: initialBooks, loans: initialLoans, apiBaseUrl, canManage,
}: {
  // NULL = the read failed. Distinct from an empty page, and the difference is
  // the whole message: "nothing matched" vs "we could not ask".
  books: Page<Book> | null; loans: Page<Loan> | null; apiBaseUrl: string; canManage: boolean;
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

  // ---------------------------------------------------------------------------
  // THE CATALOGUE IS SEARCHED WHERE IT LIVES
  // ---------------------------------------------------------------------------
  // The box used to filter the rows this component had already been handed —
  // the first 200 titles by name. So a librarian typing a book their school
  // holds was told it does not exist, for 1,600 of 1,800 titles, and the
  // barcode box behind the desk failed the same way. The server has had a
  // working `?q=` the whole time and no screen ever sent it.
  const EMPTY_BOOKS: Page<Book> = { items: [], total: 0, page: 1, pageSize: 100 };
  const EMPTY_LOANS: Page<Loan> = { items: [], total: 0, page: 1, pageSize: 50 };
  const [books, setBooks] = React.useState<Page<Book>>(initialBooks ?? EMPTY_BOOKS);
  const [bookPage, setBookPage] = React.useState(1);
  const [loans, setLoans] = React.useState<Page<Loan>>(initialLoans ?? EMPTY_LOANS);
  const [loanPage, setLoanPage] = React.useState(1);
  // OVERDUE IS A FILTER, NOT SOMETHING TO SCROLL FOR. An overdue loan is by
  // definition an old one, and the list is newest-first, so the rows the strip
  // above is alarming about were the ones furthest out of reach.
  const [loanFilter, setLoanFilter] = React.useState<"all" | "overdue" | "ISSUED" | "RETURNED">("all");
  const [listErr, setListErr] = React.useState<string | null>(
    initialBooks === null || initialLoans === null
      ? "Couldn't load the library just now. This does NOT mean it is empty — reload to try again."
      : null,
  );

  const reloadKey = `${q}|${bookPage}|${loanFilter}|${loanPage}`;
  const firstRender = React.useRef(true);
  React.useEffect(() => {
    // The server already rendered page 1 of both lists; re-fetch only once the
    // reader actually changes something.
    if (firstRender.current) { firstRender.current = false; return; }
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        const qs = new URLSearchParams();
        if (q.trim()) qs.set("q", q.trim());
        if (bookPage > 1) qs.set("page", String(bookPage));
        const ls = new URLSearchParams();
        if (loanFilter === "overdue") ls.set("overdue", "1");
        else if (loanFilter !== "all") ls.set("status", loanFilter);
        if (loanPage > 1) ls.set("page", String(loanPage));
        const [b, l] = await Promise.all([
          fetch(`/api/sms/library/books?${qs}`, { cache: "no-store" }),
          fetch(`/api/sms/library/loans?${ls}`, { cache: "no-store" }),
        ]);
        if (cancelled) return;
        // A failed read must NOT become an empty list: "no books match" is a
        // statement about the catalogue, and we do not know that.
        if (b.ok && l.ok) {
          setBooks((await b.json()) as Page<Book>);
          setLoans((await l.json()) as Page<Loan>);
          setListErr(null);
        } else {
          setListErr("Couldn't refresh the lists. This does not mean they are empty — try again.");
        }
      })();
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [reloadKey, q, bookPage, loanFilter, loanPage]);

  // Changing what you are looking for starts at the beginning of it.
  React.useEffect(() => { setBookPage(1); }, [q]);
  React.useEffect(() => { setLoanPage(1); }, [loanFilter]);
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
  // THE SEARCH CARD PROMISES "by title, author, ISBN, or barcode" and the form
  // beside it could record only a title and a barcode — so two of the four
  // things a librarian is told they can search by were things nothing could
  // store. The server has always accepted both.
  const [bAuthor, setBAuthor] = React.useState("");
  const [bIsbn, setBIsbn] = React.useState("");
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

  // Whatever the server sent back for this query — not a second filter over it.
  const shown = books.items;

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
          <CardDescription>
            By title, author, ISBN, or barcode &mdash; searched across the whole catalogue,
            not just this page. {books.total.toLocaleString()} title{books.total === 1 ? "" : "s"} held.
          </CardDescription>
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
          {shown.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {listErr
                ? listErr
                : q.trim()
                  ? `Nothing in the catalogue matches "${q.trim()}".`
                  : "The catalogue is empty."}
            </p>
          )}
          <Pager p={books} onPage={setBookPage} noun={q.trim() ? "matching" : "titles"} />
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader><CardTitle className="text-base">Add a book</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label>Title</Label><Input value={bTitle} onChange={(e) => setBTitle(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Author</Label><Input value={bAuthor} onChange={(e) => setBAuthor(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>ISBN</Label><Input value={bIsbn} onChange={(e) => setBIsbn(e.target.value)} placeholder="optional" /></div>
            <div className="space-y-1.5"><Label>Barcode</Label><Input value={bBarcode} onChange={(e) => setBBarcode(e.target.value)} placeholder="scan…" /></div>
            <div className="space-y-1.5"><Label>Copies</Label><Input className="w-20" type="number" min={1} value={bCopies} onChange={(e) => setBCopies(Number(e.target.value))} /></div>
            <Button disabled={busy || !bTitle || !bBarcode} onClick={() => run(
              () => postSms("library/books", {
                title: bTitle,
                barcode: bBarcode,
                totalCopies: bCopies,
                // Blank stays blank: an empty string is not an ISBN, and a row
                // carrying "" would match a search for "".
                author: bAuthor.trim() || null,
                isbn: bIsbn.trim() || null,
              }),
              "Book added.",
            )}>Add</Button>
            <a href={`${apiBaseUrl.replace(/\/$/, "")}/library/books/export.csv`} className="ml-auto"><Button variant="outline" type="button">Export CSV</Button></a>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{canManage ? "Loans" : "My loans"}</CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-1.5 pt-1">
            {([
              ["all", "All"],
              ["overdue", "Overdue"],
              ["ISSUED", "On loan"],
              ["RETURNED", "Returned"],
            ] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setLoanFilter(k)}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${
                  loanFilter === k ? "border-foreground bg-foreground text-background" : "border-border"
                }`}>
                {label}
              </button>
            ))}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {listErr && <p className="mb-2 text-sm text-destructive">{listErr}</p>}
          {loans.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {listErr ? "—" : loanFilter === "overdue" ? "Nothing is overdue." : "No loans."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Book</th>{canManage && <th className="py-1 pr-3 font-medium">Borrower</th>}
                <th className="py-1 pr-3 font-medium">Due</th><th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">Fine</th><th className="py-1 font-medium"></th>
              </tr></thead>
              <tbody>
                {loans.items.map((l) => (
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
          <Pager p={loans} onPage={setLoanPage} noun={loanFilter === "overdue" ? "overdue" : "loans"} />
        </CardContent>
      </Card>
    </div>
  );
}
