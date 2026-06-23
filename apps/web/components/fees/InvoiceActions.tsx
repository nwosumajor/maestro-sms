"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function InvoiceActions({ invoiceId, status }: { invoiceId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  const act = async (action: "issue" | "cancel") => {
    if (action === "cancel" && !confirm("Cancel this invoice?")) return;
    setBusy(true);
    const res = await fetch(`/api/sms/invoices/${invoiceId}/${action}`, { method: "POST" });
    setBusy(false);
    if (res.ok) router.refresh();
  };

  return (
    <div className="flex gap-2">
      {status === "DRAFT" && (
        <Button size="sm" disabled={busy} onClick={() => act("issue")}>
          Issue invoice
        </Button>
      )}
      {status !== "PAID" && status !== "CANCELLED" && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("cancel")}>
          Cancel
        </Button>
      )}
    </div>
  );
}
