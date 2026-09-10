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
    const res = await postSms<{ reminded: number; invoices: number; unreachable: number }>(
      `fees/reminders/run?overdueOnly=${overdueOnly}`,
    );
    setBusy(false);
    if (res.ok && res.data) {
      // WHO WAS TOLD, AND WHO COULD NOT BE. This said "Sent N reminder(s)"
      // where N counted invoices walked, not families reached — so a school
      // whose pupils have no guardian on file was told it had chased 30
      // families having chased none. The shortfall is nameable and fixable:
      // link a guardian.
      const { reminded, invoices, unreachable } = res.data;
      setMsg(
        invoices === 0
          ? "No invoice is overdue."
          : [
              `Told ${reminded} famil${reminded === 1 ? "y" : "ies"} across ${invoices} invoice${invoices === 1 ? "" : "s"}.`,
              unreachable > 0
                ? `${unreachable} could not be sent — no guardian is linked to those pupils, so nobody was told. Link one on the pupil's record.`
                : "",
            ]
              .filter(Boolean)
              .join(" "),
      );
    }
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
