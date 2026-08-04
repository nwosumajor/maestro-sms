"use client";

// =============================================================================
// LanguageCard — the language this person is written to in
// =============================================================================
// Twelve countries in the catalogue are francophone. This is the control that
// makes that real for an individual: the alerts, receipts and report-card
// notices they receive are written in the language chosen here.
//
// It is deliberately NOT an interface-language switch, and says so. The screens
// are still English, and a control that implied otherwise would be a promise the
// product does not keep — a parent would set it, see the menus unchanged, and
// conclude the setting is broken.
//
// "Follow my school" is the default and stays available: clearing the choice is
// how a family that moves, or a school that changes its own language, stops
// having to revisit this.
// =============================================================================

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

type State = { locale: string | null; effective: string };

const CHOICES: Array<{ value: string; label: string }> = [
  { value: "", label: "Follow my school" },
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
];

export function LanguageCard() {
  const [state, setState] = React.useState<State | null>(null);
  const [choice, setChoice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch("/api/sms/notifications/me/language");
      if (!live || !res.ok) return;
      const j = (await res.json()) as State;
      setState(j);
      setChoice(j.locale ?? "");
    })();
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/notifications/me/language", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // Empty string clears the override — the API takes null for "follow the
      // school", and a select cannot hold null.
      body: JSON.stringify({ locale: choice || null }),
    });
    if (res.ok) {
      const j = (await res.json()) as State;
      setState(j);
      setMsg("Saved.");
    } else {
      setMsg("Could not save that language.");
    }
    setBusy(false);
  }

  const effectiveLabel = state?.effective === "fr" ? "Français" : "English";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Language</CardTitle>
        <CardDescription>
          The language your alerts, receipts and report-card notices are written in. The screens themselves are in
          English for now — this changes the messages you receive.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="lang">Write to me in</Label>
            <select
              id="lang"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <Button size="sm" onClick={() => void save()} disabled={busy || choice === (state?.locale ?? "")}>
            {busy ? "Saving…" : "Save"}
          </Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </div>
        {state && (
          <p className="text-xs text-muted-foreground">
            {state.locale
              ? `You have chosen ${effectiveLabel}.`
              : `Following your school, which is currently ${effectiveLabel}.`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
