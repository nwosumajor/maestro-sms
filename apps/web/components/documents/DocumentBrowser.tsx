"use client";

import * as React from "react";
import type { DocumentRowDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { shortDate, titleCase } from "@/lib/format";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { StudentPicker } from "@/components/people/StudentPicker";

type Row = Serialized<DocumentRowDto>;

const TYPES: Array<{ value?: string; label: string }> = [
  { label: "All" },
  { value: "REPORT_CARD", label: "Report cards" },
  { value: "RECEIPT", label: "Receipts" },
  { value: "CERTIFICATE", label: "Certificates" },
  { value: "OTHER", label: "Other" },
];

/**
 * The document vault: filtered and paged against the server.
 *
 * The type/student filters existed on the API from the start and the page passed
 * neither, so it showed the 200 most recent documents and everything older was
 * unreachable — a vault that gains a report card per pupil per term passes that
 * within a year, and the loss is invisible.
 */
export function DocumentBrowser({
  initial,
  initialCursor,
  canWrite,
}: {
  initial: Row[];
  initialCursor: string | null;
  canWrite: boolean;
}) {
  const [rows, setRows] = React.useState<Row[]>(initial);
  const [cursor, setCursor] = React.useState<string | null>(initialCursor);
  const [type, setType] = React.useState<string>("");
  const [studentId, setStudentId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [bulk, setBulk] = React.useState<{ done: number; total: number } | null>(null);

  /**
   * Download every document currently listed, one at a time.
   *
   * Deliberately NOT a server-side zip: there is no archive library in this project,
   * and adding one to stream tens of files out of object storage is a bigger change
   * than this page warrants. Sequential, not parallel, so a class's worth of report
   * cards does not open thirty simultaneous connections — and the button states the
   * count up front so nobody starts a 200-file run by accident.
   */
  const downloadAll = async () => {
    const targets = rows.filter((d) => d.status === "UPLOADED");
    if (targets.length === 0) return;
    setBulk({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      const d = targets[i]!;
      try {
        const res = await fetch(`/api/sms/documents/${d.id}/file`);
        if (res.ok) {
          const url = URL.createObjectURL(await res.blob());
          const a = document.createElement("a");
          a.href = url;
          a.download = (d.title || "document").replace(/[^a-z0-9.\-_ ]/gi, "") || "document";
          a.click();
          URL.revokeObjectURL(url);
        }
      } catch {
        // One unreadable file must not abandon the rest of the run.
      }
      setBulk({ done: i + 1, total: targets.length });
    }
    setBulk(null);
  };

  const url = React.useCallback(
    (next?: string) => {
      const qs = new URLSearchParams();
      if (type) qs.set("type", type);
      if (studentId) qs.set("studentId", studentId);
      if (next) qs.set("cursor", next);
      return `/api/sms/documents?${qs.toString()}`;
    },
    [type, studentId],
  );

  const load = React.useCallback(
    async (append: boolean, next?: string) => {
      setBusy(true);
      const res = await fetch(url(next));
      if (res.ok) {
        const page = (await res.json()) as { items: Row[]; nextCursor: string | null };
        setRows((prev) => (append ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      }
      setBusy(false);
    },
    [url],
  );

  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void load(false);
  }, [type, studentId, load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border p-1">
          {TYPES.map((t) => (
            <Button key={t.label} size="sm" variant={type === (t.value ?? "") ? "default" : "ghost"} onClick={() => setType(t.value ?? "")}>
              {t.label}
            </Button>
          ))}
        </div>
        {/* Searched, never a dropdown of the school. */}
        <div className="w-56">
          <StudentPicker value={studentId} onChange={setStudentId} placeholder="Any student…" />
        </div>
        {busy && <span className="text-xs text-muted-foreground">Loading…</span>}
        {rows.some((d) => d.status === "UPLOADED") && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={!!bulk}
            onClick={() => void downloadAll()}
          >
            {bulk ? `Downloading ${bulk.done}/${bulk.total}…` : `Download all ${rows.filter((d) => d.status === "UPLOADED").length}`}
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Title</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Added</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 font-medium">{d.title}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{titleCase(d.type)}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={d.status === "UPLOADED" ? "secondary" : "outline"}>{titleCase(d.status)}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{shortDate(d.createdAt)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <DocumentActions id={d.id} title={d.title} canDownload={d.status === "UPLOADED"} canDelete={canWrite} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !busy && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    No documents match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Offered only when another page exists, so its absence means "that's all"
          rather than a button that does nothing. */}
      {cursor && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(true, cursor)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
