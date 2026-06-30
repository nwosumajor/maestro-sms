"use client";

import * as React from "react";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";

// Triggers payment reminders to guardians of students with outstanding invoices.
export function FeeReminderButton() {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const run = async (overdueOnly: boolean) => {
    setBusy(true);
    setMsg(null);
    const res = await postSms<{ reminded: number; invoices: number }>(`fees/reminders/run?overdueOnly=${overdueOnly}`);
    setBusy(false);
    if (res.ok && res.data) setMsg(`Sent ${res.data.reminded} reminder(s) across ${res.data.invoices} invoice(s).`);
    else setMsg(res.error ?? "Failed.");
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => run(false)}>Remind all outstanding</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => run(true)}>Remind overdue only</Button>
      {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
    </div>
  );
}
