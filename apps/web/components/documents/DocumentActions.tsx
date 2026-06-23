"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function DocumentActions({
  id,
  canDownload,
  canDelete,
}: {
  id: string;
  canDownload: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  const download = async () => {
    setBusy(true);
    const res = await fetch(`/api/sms/documents/${id}/download`);
    setBusy(false);
    if (!res.ok) return;
    const data = (await res.json()) as { download: { url: string } };
    // Presigned URL — opens directly against object storage.
    window.open(data.download.url, "_blank", "noopener");
  };

  const remove = async () => {
    if (!confirm("Delete this document?")) return;
    setBusy(true);
    const res = await fetch(`/api/sms/documents/${id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) router.refresh();
  };

  return (
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
  );
}
