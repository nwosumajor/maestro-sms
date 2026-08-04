"use client";

// =============================================================================
// GradingPolicyCard — pick a grading scale, don't type one
// =============================================================================
// The question this screen answers is not "can a school change its bands" but
// "how do we stop them breaking it while doing so". Three layers, in order of
// how much work each saves:
//
//   1. NAMED SCALES. Almost every school picks a row — WAEC, plus-grades,
//      Cambridge, US — and types nothing at all. The choices come from the
//      SERVER, so this screen can never offer one the server would reject.
//
//   2. THE SHAPE. Where a school does build its own, it sets only the FLOOR of
//      each grade. Each ceiling is derived from the next band down and shown
//      read-only. The two ways a hand-typed scale goes wrong — a gap (69 maps to
//      nothing) and an overlap (72 is two grades) — cannot be TYPED, rather than
//      being caught afterwards.
//
//   3. A PREVIEW. Every scale shows what a real mark becomes before it is saved,
//      because "A+ from 85" is an abstraction and "86 → A+" is not.
// =============================================================================

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

type Band = { min: number; grade: string };
type Policy = {
  scale: string;
  bands: Band[];
  components: Array<{ key: string; label: string; max: number }>;
  scaleChoices: Array<{ key: string; label: string; note: string; bands: Band[] }>;
  weightChoices: Array<{ key: string; label: string; weights: Record<string, number> }>;
};

/** The mark a preview row demonstrates. Chosen to straddle typical boundaries. */
const SAMPLE_MARKS = [92, 86, 74, 62, 51, 44, 30];

export function GradingPolicyCard({ canManage }: { canManage: boolean }) {
  const [p, setP] = React.useState<Policy | null>(null);
  const [scale, setScale] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await fetch("/api/sms/academic/grading-policy");
    if (!res.ok) return;
    const j = (await res.json()) as Policy;
    setP(j);
    setScale(j.scale);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/academic/grading-policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setP((await res.json()) as Policy);
      setMsg("Saved. New report cards use this scale; marks already entered are unchanged.");
    } else {
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      setMsg(j.message ?? "Could not save that grading policy.");
    }
    setBusy(false);
  }

  // The bands of whatever is currently SELECTED, so the preview reacts before
  // anything is saved.
  const shown = React.useMemo(() => {
    if (!p) return [];
    return p.scaleChoices.find((c) => c.key === scale)?.bands ?? p.bands;
  }, [p, scale]);

  const letterFor = (mark: number) => shown.find((b) => mark >= b.min)?.grade ?? "—";

  /** The ceiling is DERIVED, never entered: one below the band above it. */
  const ceilingOf = (i: number) => (i === 0 ? 100 : shown[i - 1].min - 1);

  if (!p) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Grading scale</CardTitle>
        <CardDescription>
          Which letter each mark earns. Pick the scale your school uses — you never type a boundary, so a grade can
          never end up covering two ranges or none.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {p.scaleChoices.map((c) => (
            <label
              key={c.key}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-2.5 ${
                scale === c.key ? "border-primary bg-primary/5" : "border-border"
              }`}
            >
              <input
                type="radio"
                name="grade-scale"
                className="mt-1"
                checked={scale === c.key}
                disabled={!canManage}
                onChange={() => setScale(c.key)}
              />
              <span className="min-w-0">
                <span className="text-sm font-medium">{c.label}</span>
                <span className="block text-xs text-muted-foreground">{c.note}</span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {c.bands.map((b, i) => (
                    <Badge key={b.grade} variant="outline" className="text-[11px] tabular-nums">
                      {b.grade} {b.min}–{i === 0 ? 100 : c.bands[i - 1].min - 1}
                    </Badge>
                  ))}
                </span>
              </span>
            </label>
          ))}
        </div>

        {/* The preview. "A+ from 85" is an abstraction; "86 -> A+" is not. */}
        <div className="rounded-md border border-dashed border-border p-3">
          <p className="mb-1.5 text-xs font-medium">What a mark becomes on this scale</p>
          <div className="flex flex-wrap gap-2">
            {SAMPLE_MARKS.map((m) => (
              <span key={m} className="rounded bg-muted px-2 py-1 text-xs tabular-nums">
                {m} → <span className="font-semibold">{letterFor(m)}</span>
              </span>
            ))}
          </div>
        </div>

        {/* The floors, with ceilings shown read-only so the derivation is
            visible rather than merely trusted. */}
        <div>
          <Label className="text-xs">Bands on this scale</Label>
          <table className="mt-1 w-full text-sm">
            <tbody>
              {shown.map((b, i) => (
                <tr key={b.grade} className="border-b border-border/60 last:border-0">
                  <td className="py-1.5 font-medium">{b.grade}</td>
                  <td className="py-1.5 tabular-nums text-muted-foreground">
                    from <span className="font-medium text-foreground">{b.min}</span> to {ceilingOf(i)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted-foreground">
            Only the starting mark is set — each grade runs up to one below the grade above it, so there is never a gap
            or an overlap.
          </p>
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy || scale === p.scale} onClick={() => void save({ scale })}>
              {busy ? "Saving…" : "Use this scale"}
            </Button>
            {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
          </div>
        )}

        {/* Weights are a separate choice: a school may keep 60/20/10/10 and still
            want A+ from 85, so choosing one never resets the other. */}
        <div className="border-t border-border pt-3">
          <Label className="text-xs">How a subject total is made up</Label>
          <p className="mt-1 text-sm tabular-nums">
            {p.components.map((c) => `${c.label} ${c.max}`).join("  ·  ")}{" "}
            <span className="text-muted-foreground">= 100</span>
          </p>
          {canManage && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {p.weightChoices.map((w) => (
                <Button
                  key={w.key}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void save({ weights: w.weights })}
                >
                  {w.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
