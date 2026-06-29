"use client";

import type { PersonSearchResultDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

type Person = Serialized<PersonSearchResultDto>;

export function DirectorySearch({ crossSchool }: { crossSchool: boolean }) {
  const [f, setF] = React.useState({ q: "", school: "", location: "", role: "" });
  const [results, setResults] = React.useState<Person[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const params = new URLSearchParams();
    if (f.q) params.set("q", f.q);
    if (crossSchool && f.school) params.set("school", f.school);
    if (f.location) params.set("location", f.location);
    if (f.role) params.set("role", f.role);
    const res = await fetch(`/api/sms/directory/search?${params.toString()}`);
    setBusy(false);
    setResults(res.ok ? ((await res.json()) as Person[]) : []);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <form onSubmit={run} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="d-q">Unique ID / name / email</Label>
              <Input id="d-q" value={f.q} onChange={set("q")} placeholder="SMS-… / name / email" className="w-56" />
            </div>
            {crossSchool && (
              <div className="space-y-1.5">
                <Label htmlFor="d-school">School name</Label>
                <Input id="d-school" value={f.school} onChange={set("school")} className="w-40" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="d-loc">Location</Label>
              <Input id="d-loc" value={f.location} onChange={set("location")} placeholder="city / state" className="w-36" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="d-role">Role</Label>
              <Input id="d-role" value={f.role} onChange={set("role")} placeholder="student / teacher" className="w-36" />
            </div>
            <Button type="submit" disabled={busy}>{busy ? "Searching…" : "Search"}</Button>
          </form>
        </CardContent>
      </Card>

      {results && (
        <Card>
          <CardContent className="space-y-1.5 p-4">
            <p className="text-xs text-muted-foreground">{results.length} result(s)</p>
            {results.length === 0 && <p className="text-sm text-muted-foreground">No matches.</p>}
            {results.map((r) => (
              <div key={r.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {r.name}{" "}
                    <span className="font-mono text-[10px] text-muted-foreground">{r.uniqueId}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.email}
                    {crossSchool && ` · ${r.schoolName}`}
                    {r.location && ` · ${r.location}`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant={r.status === "ACTIVE" ? "secondary" : "destructive"}>{r.status.toLowerCase()}</Badge>
                  {r.roles.map((role) => <Badge key={role} variant="outline" className="font-mono text-[10px]">{role}</Badge>)}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
