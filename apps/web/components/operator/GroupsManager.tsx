"use client";

// Operator: multi-school groups (franchise tier). Create a group, choose its
// member schools, and name its directors (existing users by email — they must
// belong to a member school). Directors then see /group when their own school
// has the GROUP module enabled. Writes are step-up gated server-side.

import * as React from "react";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface GroupRow {
  id: string;
  name: string;
  members: { schoolId: string; name: string }[];
  directors: { userId: string; label: string }[];
}

export function GroupsManager({
  groups,
  schools,
}: {
  groups: GroupRow[];
  schools: { id: string; name: string }[];
}) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState("");
  const [memberSel, setMemberSel] = React.useState<Record<string, string[]>>(
    Object.fromEntries(groups.map((g) => [g.id, g.members.map((m) => m.schoolId)])),
  );
  const [directorText, setDirectorText] = React.useState<Record<string, string>>(
    Object.fromEntries(groups.map((g) => [g.id, g.directors.map((d) => d.label.match(/<(.+)>/)?.[1] ?? "").filter(Boolean).join(", ")])),
  );

  const act = async (fn: () => ReturnType<typeof sendWithStepUp>, okMsg: string) => {
    setBusy(true);
    setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) {
      setMsg(okMsg);
      window.location.reload();
    } else setMsg(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Multi-school groups</CardTitle>
        <CardDescription>
          A group gives its DIRECTORS a read-only cross-campus dashboard (/group). Enable the &quot;Group
          Console&quot; module on the director&apos;s own school so the page appears in their navigation.
          Step-up required — membership widens a cross-tenant read.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {groups.map((g) => (
          <div key={g.id} className="space-y-3 rounded-md border border-border p-3">
            <p className="text-sm font-semibold">{g.name}</p>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Member schools</p>
              <div className="flex flex-wrap gap-1.5">
                {schools.map((s) => {
                  const on = (memberSel[g.id] ?? []).includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() =>
                        setMemberSel((cur) => ({
                          ...cur,
                          [g.id]: on ? (cur[g.id] ?? []).filter((x) => x !== s.id) : [...(cur[g.id] ?? []), s.id],
                        }))
                      }
                      className={
                        "rounded-md border px-2 py-1 text-xs transition-colors " +
                        (on ? "border-primary bg-primary/10 font-medium" : "border-border hover:bg-accent")
                      }
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={busy}
                onClick={() =>
                  act(
                    () => sendWithStepUp("PUT", `operator/groups/${g.id}/members`, { schoolIds: memberSel[g.id] ?? [] }),
                    "Members saved.",
                  )
                }
              >
                Save members
              </Button>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Directors (emails, comma-separated — must belong to a member school)
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="w-80"
                  placeholder="proprietor@school.com, md@group.com"
                  value={directorText[g.id] ?? ""}
                  onChange={(e) => setDirectorText((cur) => ({ ...cur, [g.id]: e.target.value }))}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        sendWithStepUp("PUT", `operator/groups/${g.id}/directors`, {
                          emails: (directorText[g.id] ?? "")
                            .split(",")
                            .map((e) => e.trim())
                            .filter(Boolean),
                        }),
                      "Directors saved.",
                    )
                  }
                >
                  Save directors
                </Button>
              </div>
              {g.directors.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">Current: {g.directors.map((d) => d.label).join(" · ")}</p>
              )}
            </div>
          </div>
        ))}

        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <Input className="w-64" placeholder="New group name (e.g. Greenfield Group)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button
            size="sm"
            disabled={busy || !newName.trim()}
            onClick={() => act(() => sendWithStepUp("POST", "operator/groups", { name: newName.trim() }), "Group created.")}
          >
            Create group
          </Button>
        </div>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
