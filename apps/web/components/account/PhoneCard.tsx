"use client";

// Self-service mobile number: the delivery target for SMS/WhatsApp alerts
// (fee reminders, absence notices, receipts). Self-scoped; audited server-side.

import * as React from "react";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function PhoneCard({ initialPhone }: { initialPhone: string | null }) {
  const [phone, setPhone] = React.useState(initialPhone ?? "");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/notifications/me/phone", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: phone.trim() }),
    });
    setBusy(false);
    if (res.ok) setMsg(phone.trim() ? "Saved — SMS/WhatsApp alerts will use this number." : "Number cleared.");
    else setMsg(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Mobile number</CardTitle>
        <CardDescription>
          Where the school&apos;s SMS and WhatsApp alerts reach you (fee reminders, absence notices,
          receipts). International format. Leave blank to receive email and in-app notices only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="acct-phone">Phone</Label>
          <Input
            id="acct-phone"
            inputMode="tel"
            placeholder="+2348012345678"
            className="w-52"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ""))}
          />
        </div>
        <Button onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save number"}
        </Button>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
