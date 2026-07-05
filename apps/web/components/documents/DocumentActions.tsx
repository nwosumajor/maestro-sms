"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { readApiError } from "@/lib/api-error";

export function DocumentActions({
  id,
  title,
  canDownload,
  canDelete,
}: {
  id: string;
  title?: string;
  canDownload: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setErr(null);
    // Stream the bytes through the API (works with the local stub AND S3/R2);
    // the browser never needs bucket credentials.
    const res = await fetch(`/api/sms/documents/${id}/file`);
    setBusy(false);
    if (!res.ok) { setErr(await readApiError(res)); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (title ?? "document").replace(/[^a-z0-9.\-_ ]/gi, "") || "document";
    a.click();
    URL.revokeObjectURL(url);
  };

  const remove = async () => {
    if (!confirm("Delete this document?")) return;
    setBusy(true);
    const res = await fetch(`/api/sms/documents/${id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) router.refresh();
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex justify-end gap-2">
        {canDownload && (
          <Button size="sm" variant="outline" disabled={busy} onClick={download}>
            Download
          </Button>
        )}
        {canDelete && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>
            Delete
          </Button>
        )}
      </div>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
