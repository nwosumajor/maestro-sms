"use client";

// =============================================================================
// SubjectCatalogue — pick a school's subjects instead of typing them
// =============================================================================
// Setting a school up meant typing every subject by hand: twenty minutes, and
// three schools end up with "Maths", "Mathematics" and "MATHS", after which no
// cross-school question can be asked and a transferring pupil's record cannot be
// lined up with their new school's.
//
// The list follows the school's COUNTRY, so a school in Dakar is offered
// Français and Histoire-Géographie rather than English Language.
//
// Three things this screen has to get right:
//   • grouped by stage and stream, because a senior list is fifty-odd entries
//     and one alphabetical column is a list nobody finishes
//   • what is ALREADY added is shown and disabled, not hidden — hiding it looks
//     like the catalogue is missing a subject you know exists
//   • custom subjects stay a first-class route, said out loud, because no
//     catalogue covers every school
// =============================================================================

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Entry = {
  code: string;
  name: string;
  group: string;
  stages: string[];
  added: boolean;
};
type Catalogue = { curriculum: string; country: string | null; subjects: Entry[] };

const STAGES = [
  { key: "PRE_PRIMARY", label: "Pre-primary" },
  { key: "PRIMARY", label: "Primary" },
  { key: "JUNIOR_SECONDARY", label: "Junior secondary" },
  { key: "SENIOR_SECONDARY", label: "Senior secondary" },
];

export function SubjectCatalogue() {
  const router = useRouter();
  const [cat, setCat] = React.useState<Catalogue | null>(null);
  const [stage, setStage] = React.useState("PRIMARY");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await fetch(`/api/sms/subjects/catalogue?stage=${encodeURIComponent(stage)}`);
    if (res.ok) setCat((await res.json()) as Catalogue);
  }, [stage]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const toggle = (code: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  async function add() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/subjects/from-catalogue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codes: [...picked] }),
    });
    if (res.ok) {
      const j = (await res.json()) as { added: unknown[]; skipped: Array<{ code: string; reason: string }> };
      // Report the skips rather than swallowing them: someone who ticked twelve
      // boxes and got eleven subjects needs to know which one, and why.
      setMsg(
        `Added ${j.added.length}.` +
          (j.skipped.length ? ` Skipped ${j.skipped.length}: ${j.skipped.map((s) => `${s.code} (${s.reason})`).join(", ")}` : ""),
      );
      setPicked(new Set());
      await load();
      router.refresh();
    } else {
      setMsg("Could not add those subjects.");
    }
    setBusy(false);
  }

  const groups = React.useMemo(() => {
    const out = new Map<string, Entry[]>();
    for (const s of cat?.subjects ?? []) {
      const arr = out.get(s.group) ?? [];
      arr.push(s);
      out.set(s.group, arr);
    }
    return [...out.entries()];
  }, [cat]);

  const availableCount = (cat?.subjects ?? []).filter((s) => !s.added).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Add subjects from the catalogue</CardTitle>
        <CardDescription>
          The standard list for {cat?.country ? `your country (${cat.country})` : "your region"}. Picking one creates
          your school&rsquo;s own copy — rename it afterwards and it stays linked for reporting. Anything not here can
          still be added as a custom subject below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {STAGES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStage(s.key)}
              aria-pressed={stage === s.key}
              className={`rounded-md border px-2.5 py-1 text-sm ${
                stage === s.key ? "border-primary bg-primary/10 text-primary" : "border-border"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {!cat ? (
          <p className="text-sm text-muted-foreground">Loading the catalogue…</p>
        ) : availableCount === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every subject in this stage&rsquo;s catalogue is already on your list.
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map(([group, entries]) => (
              <div key={group}>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</p>
                <div className="flex flex-wrap gap-1.5">
                  {entries.map((e) => (
                    <button
                      key={e.code}
                      type="button"
                      disabled={e.added}
                      onClick={() => toggle(e.code)}
                      aria-pressed={picked.has(e.code)}
                      title={e.added ? "Already on your list" : `Add ${e.name} (${e.code})`}
                      className={`rounded-md border px-2 py-1 text-sm ${
                        e.added
                          ? "cursor-default border-border bg-muted/50 text-muted-foreground"
                          : picked.has(e.code)
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border hover:border-primary"
                      }`}
                    >
                      {e.name}
                      {e.added && <span className="ml-1 text-xs">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" disabled={picked.size === 0 || busy} onClick={() => void add()}>
            {busy ? "Adding…" : `Add ${picked.size || ""} selected`}
          </Button>
          {cat && (
            <Badge variant="outline" className="text-xs">
              {cat.curriculum}
            </Badge>
          )}
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
