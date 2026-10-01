"use client";

// =============================================================================
// Operator: multi-school groups (franchise tier)
// =============================================================================
// Create a group, choose its member schools, name its directors — and rename or
// remove it. Directors then see /group when their own school has the GROUP
// module enabled. Every write is step-up gated server-side.
//
// Three things this screen used to get wrong, and why it is shaped as it is:
//   • Member schools were a wall of toggle buttons, one per school on the
//     PLATFORM. At hundreds of schools nobody can find one; it is a search now,
//     with the chosen schools held in state so a pick survives the next search.
//   • Directors were typed as emails, and an address that matched nobody — or a
//     pupil, or a leaver — was dropped in silence under "Directors saved". They
//     are chosen from the people who MAY direct (active staff at a member
//     school), and every write reports what it did NOT apply, and why.
//   • Each save reloaded the page, which threw away the message saying what
//     happened. It refreshes the data and keeps the message.
// =============================================================================

import * as React from "react";
import { useRouter } from "next/navigation";
import type { GroupAdminDto, GroupDirectorCandidatePageDto, GroupWriteResultDto } from "@sms/types";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { readJson } from "@/lib/read-json";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type School = { id: string; name: string };
type Outcome = { tone: "ok" | "warn" | "error"; lines: string[] };

/** What a write did — and, louder, what it did not. */
function describe(result: GroupWriteResultDto, noun: string): Outcome {
  const lines = [`Saved ${result.applied} ${noun}${result.applied === 1 ? "" : "s"}.`];
  for (const n of result.notApplied) lines.push(`Not applied — ${n.value}: ${n.reason}`);
  for (const d of result.removedDirectors) {
    lines.push(`Removed director ${d.name} <${d.email}> — their school is no longer in the group.`);
  }
  return { tone: result.notApplied.length > 0 || result.removedDirectors.length > 0 ? "warn" : "ok", lines };
}

function OutcomeNote({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  const tone =
    outcome.tone === "error" ? "text-destructive" : outcome.tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground";
  return (
    <div className={`space-y-0.5 text-sm ${tone}`} role="status">
      {outcome.lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

function GroupEditor({
  group,
  schools,
  onDeleted,
}: {
  group: GroupAdminDto;
  schools: School[];
  /** The editor unmounts with its group, so the parent says it was deleted. */
  onDeleted: (outcome: Outcome) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);

  const [name, setName] = React.useState(group.name);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // Members: the chosen set lives in state, so a school picked from one search
  // is still chosen after the next.
  const [members, setMembers] = React.useState<School[]>(group.members.map((m) => ({ id: m.schoolId, name: m.name })));
  const [schoolQ, setSchoolQ] = React.useState("");
  const chosen = new Set(members.map((m) => m.id));
  const schoolMatches = React.useMemo(() => {
    const needle = schoolQ.trim().toLowerCase();
    if (!needle) return [];
    return schools.filter((s) => !chosen.has(s.id) && s.name.toLowerCase().includes(needle)).slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `chosen` is derived from `members`
  }, [schoolQ, schools, members]);
  const schoolTotal = React.useMemo(() => {
    const needle = schoolQ.trim().toLowerCase();
    return needle ? schools.filter((s) => !chosen.has(s.id) && s.name.toLowerCase().includes(needle)).length : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `chosen` is derived from `members`
  }, [schoolQ, schools, members]);

  // Directors: chosen from the server's list of people who MAY direct.
  const [directors, setDirectors] = React.useState(group.directors.map((d) => ({ email: d.email, label: `${d.name} <${d.email}>`, schoolName: d.schoolName })));
  const [personQ, setPersonQ] = React.useState("");

  // After a save the page refreshes and the server's state arrives as a NEW
  // `group`. Re-seed from it — what was not applied must disappear from the
  // editor — without remounting, which would throw away the outcome message.
  // Keyed on the CONTENT, not the object: a refresh after another group's save
  // hands every editor a new object, and must not wipe this one's unsaved edits.
  const saved = JSON.stringify(group);
  React.useEffect(() => {
    setName(group.name);
    setMembers(group.members.map((m) => ({ id: m.schoolId, name: m.name })));
    setDirectors(group.directors.map((d) => ({ email: d.email, label: `${d.name} <${d.email}>`, schoolName: d.schoolName })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `saved` IS `group`, compared by value
  }, [saved]);
  const [candidates, setCandidates] = React.useState<GroupDirectorCandidatePageDto | null>(null);
  const [candidateError, setCandidateError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const term = personQ.trim();
    if (term.length < 2) {
      setCandidates(null);
      setCandidateError(null);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/sms/operator/groups/${group.id}/director-candidates?q=${encodeURIComponent(term)}`, {
          signal: ctl.signal,
        });
        if (!res.ok) {
          setCandidateError(await readApiError(res));
          setCandidates(null);
          return;
        }
        setCandidateError(null);
        setCandidates(await readJson<GroupDirectorCandidatePageDto>(res));
      } catch {
        /* aborted by the next keystroke */
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [personQ, group.id]);

  const run = async (fn: () => Promise<Response>, onOk: (res: Response) => Promise<Outcome>) => {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fn();
      if (res.ok) {
        setOutcome(await onOk(res));
        router.refresh();
      } else {
        setOutcome({ tone: "error", lines: [await readApiError(res)] });
      }
    } finally {
      setBusy(false);
    }
  };

  const membersChanged =
    members.length !== group.members.length || members.some((m) => !group.members.some((g) => g.schoolId === m.id));
  const directorsChanged =
    directors.length !== group.directors.length || directors.some((d) => !group.directors.some((g) => g.email === d.email));

  return (
    <div className="space-y-4 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-72 font-semibold" value={name} onChange={(e) => setName(e.target.value)} aria-label="Group name" />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !name.trim() || name.trim() === group.name}
          onClick={() =>
            run(
              () => sendWithStepUp("PATCH", `operator/groups/${group.id}`, { name: name.trim() }),
              async () => ({ tone: "ok", lines: ["Renamed."] }),
            )
          }
        >
          Rename
        </Button>
        <span className="ml-auto" />
        {/* Two clicks rather than a browser confirm(): the second button says
            exactly what will happen. */}
        {confirmDelete ? (
          <>
            <span className="text-xs text-destructive">
              Removes the group and every director&apos;s access. No school&apos;s own data is touched.
            </span>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const res = await sendWithStepUp("DELETE", `operator/groups/${group.id}`);
                setBusy(false);
                if (res.ok) {
                  onDeleted({ tone: "ok", lines: [`Deleted “${group.name}”. Its directors no longer have a group console.`] });
                  router.refresh();
                } else {
                  setOutcome({ tone: "error", lines: [await readApiError(res)] });
                }
              }}
            >
              Delete group
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
            Delete…
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Member schools ({members.length})</p>
        <div className="flex flex-wrap gap-1.5">
          {members.length === 0 && <span className="text-xs text-muted-foreground">None yet.</span>}
          {members.map((m) => (
            <Badge key={m.id} variant="outline" className="gap-1">
              {m.name}
              <button
                type="button"
                className="ml-1 text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${m.name}`}
                onClick={() => setMembers((cur) => cur.filter((x) => x.id !== m.id))}
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
        <Input
          className="h-8 w-72"
          placeholder="Add a school — type its name"
          value={schoolQ}
          onChange={(e) => setSchoolQ(e.target.value)}
          aria-label="Find a school to add"
        />
        {schoolMatches.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {schoolMatches.map((s) => (
              <button
                key={s.id}
                type="button"
                className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                onClick={() => {
                  setMembers((cur) => [...cur, s]);
                  setSchoolQ("");
                }}
              >
                + {s.name}
              </button>
            ))}
            {schoolTotal > schoolMatches.length && (
              <span className="self-center text-xs text-muted-foreground">
                {schoolTotal - schoolMatches.length} more match — keep typing
              </span>
            )}
          </div>
        )}
        {schoolQ.trim() && schoolTotal === 0 && <p className="text-xs text-muted-foreground">No other school matches.</p>}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !membersChanged}
          onClick={() =>
            run(
              () => sendWithStepUp("PUT", `operator/groups/${group.id}/members`, { schoolIds: members.map((m) => m.id) }),
              async (res) => {
                const r = await readJson<GroupWriteResultDto>(res);
                return r ? describe(r, "member school") : { tone: "ok", lines: ["Members saved."] };
              },
            )
          }
        >
          Save members
        </Button>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          Directors ({directors.length}) — active staff at a member school. Save the members first if you are adding a
          new school&apos;s staff.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {directors.length === 0 && <span className="text-xs text-muted-foreground">No director — nobody can open this group&apos;s console.</span>}
          {directors.map((d) => (
            <Badge key={d.email} variant="outline" className="gap-1">
              {d.label}
              {d.schoolName && <span className="text-muted-foreground"> · {d.schoolName}</span>}
              <button
                type="button"
                className="ml-1 text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${d.label}`}
                onClick={() => setDirectors((cur) => cur.filter((x) => x.email !== d.email))}
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
        <Input
          className="h-8 w-72"
          placeholder="Find staff by name or email"
          value={personQ}
          onChange={(e) => setPersonQ(e.target.value)}
          aria-label="Find a director"
        />
        {candidateError && <p className="text-xs text-destructive">{candidateError}</p>}
        {candidates && (
          <div className="space-y-1">
            {candidates.rows.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nobody matches among the active staff of this group&apos;s member schools.
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {candidates.rows
                .filter((c) => !directors.some((d) => d.email === c.email))
                .map((c) => (
                  <button
                    key={c.userId}
                    type="button"
                    className="rounded-md border border-border px-2 py-1 text-left text-xs hover:bg-accent"
                    onClick={() => {
                      setDirectors((cur) => [...cur, { email: c.email, label: `${c.name} <${c.email}>`, schoolName: c.schoolName }]);
                      setPersonQ("");
                    }}
                  >
                    + {c.name} <span className="text-muted-foreground">&lt;{c.email}&gt; · {c.schoolName}</span>
                  </button>
                ))}
            </div>
            {candidates.total > candidates.rows.length && (
              <p className="text-xs text-muted-foreground">
                Showing {candidates.rows.length} of {candidates.total} — type more of the name to narrow it.
              </p>
            )}
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !directorsChanged}
          onClick={() =>
            run(
              () => sendWithStepUp("PUT", `operator/groups/${group.id}/directors`, { emails: directors.map((d) => d.email) }),
              async (res) => {
                const r = await readJson<GroupWriteResultDto>(res);
                return r ? describe(r, "director") : { tone: "ok", lines: ["Directors saved."] };
              },
            )
          }
        >
          Save directors
        </Button>
      </div>

      <OutcomeNote outcome={outcome} />
    </div>
  );
}

export function GroupsManager({ groups, schools }: { groups: GroupAdminDto[]; schools: School[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  const [newName, setNewName] = React.useState("");

  const create = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await sendWithStepUp("POST", "operator/groups", { name: newName.trim() });
      if (res.ok) {
        setOutcome({ tone: "ok", lines: [`Created “${newName.trim()}”. Add its member schools, then its directors.`] });
        setNewName("");
        router.refresh();
      } else {
        setOutcome({ tone: "error", lines: [await readApiError(res)] });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Multi-school groups ({groups.length})</CardTitle>
        <CardDescription>
          A group gives its DIRECTORS a read-only cross-campus dashboard (/group). Enable the &quot;Group
          Console&quot; module on the director&apos;s own school so the page appears in their navigation.
          Step-up required — membership widens a cross-tenant read.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {groups.map((g) => (
          <GroupEditor key={g.id} group={g} schools={schools} onDeleted={setOutcome} />
        ))}

        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <Input
            className="w-64"
            placeholder="New group name (e.g. Greenfield Group)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New group name"
          />
          <Button size="sm" disabled={busy || !newName.trim()} onClick={create}>
            Create group
          </Button>
        </div>
        <OutcomeNote outcome={outcome} />
      </CardContent>
    </Card>
  );
}
