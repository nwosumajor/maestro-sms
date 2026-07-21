"use client";

import * as React from "react";
import type { NotificationPreferenceDto, Serialized } from "@sms/types";
import { MUTABLE_NOTIFICATION_TYPES } from "@sms/types";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";

// Self-service external-channel delivery preferences. The in-app inbox is
// always on (noted in the UI); these toggles gate email / SMS / WhatsApp and
// let the user mute noisy categories. Security & payment notices always send.
export function NotificationPreferences({ initial }: { initial: Serialized<NotificationPreferenceDto> }) {
  const [pref, setPref] = React.useState<NotificationPreferenceDto>({
    emailEnabled: initial.emailEnabled,
    smsEnabled: initial.smsEnabled,
    whatsappEnabled: initial.whatsappEnabled,
    mutedTypes: initial.mutedTypes,
  });
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const toggleMute = (type: string) =>
    setPref((p) => ({
      ...p,
      mutedTypes: p.mutedTypes.includes(type) ? p.mutedTypes.filter((t) => t !== type) : [...p.mutedTypes, type],
    }));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const res = await sendSms("PUT", "notifications/me/preferences", pref);
    setBusy(false);
    setMsg(res.ok ? "Preferences saved." : res.error ?? "Failed.");
  };

  const channel = (key: "emailEnabled" | "smsEnabled" | "whatsappEnabled", label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={pref[key]} onChange={() => setPref((p) => ({ ...p, [key]: !p[key] }))} />
      {label}
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-medium">Channels</p>
        <div className="flex flex-wrap gap-4">
          {channel("emailEnabled", "Email")}
          {channel("smsEnabled", "SMS")}
          {channel("whatsappEnabled", "WhatsApp")}
        </div>
        <p className="text-xs text-muted-foreground">
          The in-app inbox always receives every notification. Security and payment notices are always sent on your
          active channels regardless of the mutes below.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Mute these on email/SMS/WhatsApp</p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {MUTABLE_NOTIFICATION_TYPES.map((t) => (
            <label key={t.type} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pref.mutedTypes.includes(t.type)} onChange={() => toggleMute(t.type)} />
              {t.label}
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={save}>
          Save preferences
        </Button>
        {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
      </div>
    </div>
  );
}
