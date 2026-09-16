"use client";

import {
  BULK_IMPORT_MAX_ROWS,
  bulkImportTooLarge,
  parseCsv,
  SIS_IMPORT_COLUMNS,
  SIS_IMPORT_HEADERS,
  SIS_REQUIRED_PROFILE_FIELDS,
} from "@sms/types";
import type { StudentImportBatchDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Batch = Serialized<StudentImportBatchDto>;

// The columns and the parser both come from `@sms/types`.
//
// This file used to carry its OWN copy of the header list, hand-kept beside the
// API's. The CSV is matched BY HEADER NAME, so a drift between the two was not a
// crash — it was a column a school filled in and the platform quietly dropped.
//
// It also used to parse with `line.split(",")`. The address is the column most
// likely to contain a comma, and a spreadsheet quotes it: `"12 Main St, Ikeja"`
// became `address: '"12 Main St'` with every later column SHIFTED BY ONE, so the
// pupil enrolled in a class called `Ikeja"`. `parseCsv` is quote-aware.

/** Which profile fields the family is asked for when a column is left blank. */
const REQUIRED_FOR_COMPLETE = new Set<string>(SIS_REQUIRED_PROFILE_FIELDS);

export function SisImport({ batches, currentUserId }: { batches: Batch[]; currentUserId: string }) {
  const router = useRouter();
  // The starting text is the SAME shape as the downloaded template, built from
  // the same header list — so pasting and downloading can never disagree.
  const [csv, setCsv] = React.useState(
    [
      SIS_IMPORT_HEADERS.join(","),
      `Ada Lovelace,ADM-001,SS3 Science A,2012-05-01,F,ada@example.com,08000000000,"12 Main St, Ikeja",,Lagos,Lagos`,
      `Bolu Eze,ADM-002,JSS1,2012-09-14,M,,,,,,`,
    ].join("\n"),
  );
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  // One-time credentials from the LAST approval — shown once, never persisted.
  const [creds, setCreds] = React.useState<{ name: string; email: string; tempPassword: string; admissionNumber: string }[] | null>(null);

  const downloadTemplate = async () => {
    const res = await fetch("/api/sms/admin/students/import/template");
    if (!res.ok) { setMsg(`Template download failed (${res.status}).`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "sis-import-template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  /** Load the filled-in template FILE straight into the CSV box (client-side
   *  read — the data still goes through the same staged, maker-checker path). */
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result ?? ""));
      setMsg(`Loaded ${file.name} — review below, then press "Stage import".`);
    };
    reader.onerror = () => setMsg("Could not read that file.");
    reader.readAsText(file);
    e.target.value = ""; // allow re-selecting the same file
  };

  const stage = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseCsv(csv);
    const rows = parsed
      // Only NAME is required — the sign-in identifier is generated from it.
      .filter((r) => r.name)
      // BUILT FROM THE COLUMN TABLE, not hand-listed. A hand-listed mapper is
      // exactly how `city` and `state` get added to the template and dropped on
      // the way to the server — which is the defect this change exists for.
      // `parseCsv` has already folded the legacy `address`/`classId` headers
      // onto their current names.
      .map((r) => {
        const row: Record<string, string | null> = { name: r.name };
        for (const col of SIS_IMPORT_COLUMNS) {
          if (col.key === "name") continue;
          row[col.key] = r[col.key] || null;
        }
        return row;
      });
    if (rows.length === 0) { setMsg("No valid rows — every row needs at least a name."); return; }
    // Say it BEFORE the upload. The server refuses the same file with the same
    // sentence; meeting that after choosing a file teaches nothing the picker
    // could have said first.
    if (rows.length > BULK_IMPORT_MAX_ROWS) { setMsg(bulkImportTooLarge("student", rows.length)); return; }
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/admin/students/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows }),
    });
    setBusy(false);
    if (res.ok) {
      const b = (await res.json()) as Batch;
      const upd = b.summary?.updateCount ?? 0;
      setMsg(
        `Staged ${b.summary?.total ?? rows.length} rows (${b.summary?.newCount ?? "?"} new` +
          (upd ? `, ${upd} to update` : "") +
          `, ${b.summary?.duplicateCount ?? "?"} duplicate). Awaiting approval by a different admin.`,
      );
      router.refresh();
    } else setMsg(await readApiError(res));
  };

  const decide = async (id: string, action: "approve" | "reject") => {
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/sms/admin/students/import/${id}/${action}`, { method: "POST" });
    setBusy(false);
    if (res.ok) {
      const b = (await res.json()) as Batch;
      if (action === "approve") {
        setCreds(b.credentials ?? null);
        setMsg(
          `Approved — created ${b.summary?.created ?? 0}, updated ${b.summary?.updated ?? 0}, ` +
            `skipped ${b.summary?.skipped ?? 0}.`,
        );
      } else setMsg("Batch rejected.");
      router.refresh();
    } else setMsg(await readApiError(res, "A different admin (not the uploader) must approve."));
  };

  const pending = batches.filter((b) => b.status === "PENDING");

  /** Download the one-time credential slips as CSV (quoted; formula-guarded). */
  const downloadCreds = () => {
    if (!creds) return;
    const cell = (v: string) => {
      let t = v;
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // formula-injection guard
      return `"${t.replace(/"/g, '""')}"`;
    };
    // Header says "signInId", not "email": these identifiers do not receive mail,
    // and a slip labelled "email" is exactly how that gets misunderstood.
    const csvText = ["name,admissionNumber,signInId,temporaryPassword", ...creds.map((c) => [c.name, c.admissionNumber, c.email, c.tempPassword].map(cell).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csvText], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "student-login-slips.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stage a bulk SIS upload</CardTitle>
          <CardDescription>
            Download the template, fill it in, then <strong>upload the file</strong> (or paste the CSV) and
            stage it. Nothing is created until a <strong>different</strong> admin approves the batch
            (maker-checker).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={downloadTemplate}>Download blank template</Button>
            {/* THE CORRECTION LOOP, and the reason it is on THIS screen: the
                roster export is in the template's own shape, so fixing a typo or
                filling in the columns you did not have on the day is a download,
                an edit and an upload — not one pupil at a time for ever. It was
                only ever linked from the admin dashboard, away from the page
                where somebody realises they need it. */}
            <a
              href="/api/sms/admin/export/students.csv"
              download
              className="inline-flex h-8 items-center rounded-md border border-input bg-card px-3 text-xs font-medium hover:bg-accent"
            >
              Download current roll (to correct)
            </a>
            <Label
              htmlFor="sis-file"
              className="inline-flex h-8 cursor-pointer items-center rounded-md border border-input bg-card px-3 text-xs font-medium hover:bg-accent"
            >
              Upload filled template (.csv)
            </Label>
            <input id="sis-file" type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} />
          </div>
          <form onSubmit={stage} className="space-y-3">
            {/* WHAT EACH COLUMN IS FOR, on the screen that asks for the file.
                The template's own example rows are the other half of this, but a
                school deciding WHICH of its records to gather needs to see the
                list before it opens a spreadsheet. */}
            <details className="rounded-md border border-border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                What goes in each column ({SIS_IMPORT_COLUMNS.length})
              </summary>
              <div className="border-t border-border px-3 py-2">
                <p className="mb-2 text-xs text-muted-foreground">
                  Only <span className="font-mono">name</span> is required. Fill in what your register already
                  holds — <strong>every blank marked &ldquo;asked of the family&rdquo; becomes a reminder</strong>{" "}
                  to the pupil and their guardians until somebody completes it, so a column you can fill in now
                  is a chase you never have to make.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="py-1 pr-3 font-medium">Column</th>
                        <th className="py-1 pr-3 font-medium">What it is</th>
                        <th className="py-1 font-medium">If left blank</th>
                      </tr>
                    </thead>
                    <tbody>
                      {SIS_IMPORT_COLUMNS.map((col) => (
                        <tr key={col.key} className="border-b border-border/50 last:border-0 align-top">
                          <td className="py-1 pr-3 font-mono">{col.key}</td>
                          <td className="py-1 pr-3">
                            {col.label}
                            {col.hint && <span className="block text-muted-foreground">{col.hint}</span>}
                          </td>
                          <td className="py-1">
                            {col.required ? (
                              <span className="text-destructive">the row is skipped</span>
                            ) : REQUIRED_FOR_COMPLETE.has(col.profileField ?? "") ? (
                              "asked of the family"
                            ) : (
                              "left empty"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Medical details and emergency contacts are deliberately not in this file — they are entered
                  on the pupil&rsquo;s own record, where they are encrypted and every read is logged.
                </p>
              </div>
            </details>
            <div className="space-y-1.5">
              <Label htmlFor="sis-csv">CSV (header row required)</Label>
              <p className="text-xs text-muted-foreground">
                Write <span className="font-mono">class</span> the way you say it — &ldquo;SS3 Science A&rdquo;
                or the class code. Anything that matches no class is listed back to you before anything is
                created. A cell containing a comma must be in &ldquo;quotes&rdquo;, which is what a spreadsheet
                does for you.
              </p>
              <Textarea id="sis-csv" value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} className="font-mono text-xs" />
            </div>
            <Button type="submit" disabled={busy}>{busy ? "Staging…" : "Stage import"}</Button>
          </form>
          {msg && <p className="rounded-md bg-muted px-3 py-2 text-sm">{msg}</p>}
        </CardContent>
      </Card>

            {creds && creds.length > 0 && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-base">Student sign-in slips — save these NOW</CardTitle>
            <CardDescription>
              Each new student got a unique temporary password, shown ONLY this once (it is never stored in
              readable form). Download the slips and hand them out; every student must set their own password
              at first sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-2">
              <Button size="sm" onClick={downloadCreds}>Download login slips (CSV)</Button>
              <Button size="sm" variant="ghost" onClick={() => setCreds(null)}>Dismiss</Button>
            </div>
            <div className="max-h-48 overflow-y-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Name</th><th className="px-2 py-1 font-medium">Admission no.</th><th className="px-2 py-1 font-medium">Sign-in ID</th><th className="px-2 py-1 font-medium">Temporary password</th>
                </tr></thead>
                <tbody>
                  {creds.map((c) => (
                    <tr key={c.email} className="border-b border-border/50 last:border-0">
                      <td className="px-2 py-1">{c.name}</td><td className="px-2 py-1 font-mono">{c.admissionNumber}</td><td className="px-2 py-1">{c.email}</td>
                      <td className="px-2 py-1 font-mono">{c.tempPassword}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

<Card>
        <CardHeader>
          <CardTitle className="text-base">Import batches ({pending.length} pending)</CardTitle>
          <CardDescription>Review staged batches. You can&apos;t approve a batch you uploaded yourself.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {batches.length === 0 && <p className="text-sm text-muted-foreground">No batches yet.</p>}
          {batches.map((b) => {
            const mine = b.uploadedById === currentUserId;
            const updateCount = b.summary?.updateCount ?? 0;
            return (
              <div key={b.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {b.rowCount} rows{" "}
                    <Badge variant={b.status === "APPROVED" ? "secondary" : b.status === "REJECTED" ? "destructive" : "outline"}>
                      {b.status.toLowerCase()}
                    </Badge>
                    {mine && <span className="ml-2 text-xs text-muted-foreground">(uploaded by you)</span>}
                  </p>
                  {b.summary && (
                    <p className="text-xs text-muted-foreground">
                      {b.status === "APPROVED"
                        ? `created ${b.summary.created ?? 0}, updated ${b.summary.updated ?? 0}, skipped ${b.summary.skipped ?? 0}`
                        : `${b.summary.newCount} new, ${updateCount} to update, ${b.summary.duplicateCount} duplicate`}
                    </p>
                  )}
                  {/* CLASSES THE FILE NAMED THAT MATCH NOTHING — before anything
                      is created, because a misspelt class enrols the pupil
                      nowhere and would otherwise say nothing. */}
                  {b.summary?.unknownClasses && b.summary.unknownClasses.length > 0 && (
                    <p className="mt-1 text-xs text-destructive">
                      No class matches: {b.summary.unknownClasses.join(", ")}. Those pupils will be created but
                      not enrolled.
                    </p>
                  )}
                  {/* WHAT AN APPROVAL WOULD CHANGE ON PUPILS ALREADY ON ROLL.
                      An update rewrites a child's record, so the person
                      approving it has to be able to SEE what it rewrites — a
                      count alone asks somebody to sign for something invisible. */}
                  {b.status === "PENDING" && updateCount > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        {updateCount} existing {updateCount === 1 ? "pupil" : "pupils"} would be changed — review
                        before approving
                      </summary>
                      <div className="mt-1 max-h-56 overflow-auto rounded-md border border-border">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border text-left text-muted-foreground">
                              <th className="px-2 py-1 font-medium">Admission no.</th>
                              <th className="px-2 py-1 font-medium">Pupil</th>
                              <th className="px-2 py-1 font-medium">Changes</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(b.summary?.updates ?? []).map((u) => (
                              <tr key={u.admissionNumber} className="border-b border-border/50 align-top last:border-0">
                                <td className="px-2 py-1 font-mono">{u.admissionNumber}</td>
                                <td className="px-2 py-1">{u.name}</td>
                                <td className="px-2 py-1">
                                  {u.changes.map((c) => (
                                    <span key={c.field} className="mr-2 inline-block">
                                      <span className="font-mono">{c.field}</span>{" "}
                                      <span className="text-muted-foreground">{c.from ?? "(blank)"}</span> →{" "}
                                      <span>{c.to}</span>
                                    </span>
                                  ))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {updateCount > (b.summary?.updates?.length ?? 0) && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Showing the first {b.summary?.updates?.length ?? 0} of {updateCount}.
                        </p>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground">
                        A blank cell never clears a stored value — only the columns listed above change.
                      </p>
                    </details>
                  )}
                </div>
                {b.status === "PENDING" && (
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" className="h-7" disabled={busy || mine} onClick={() => decide(b.id, "approve")}>
                      Approve
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => decide(b.id, "reject")}>
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
