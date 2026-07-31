"use client";

import * as React from "react";
import Link from "next/link";
import type { ClassOverviewDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Row = Serialized<ClassOverviewDto>;

/**
 * The class list, as something you can manage a school by.
 *
 * It used to render a name and the class's raw UUID. A UUID answers no question a
 * head of school has: not who is responsible for the room, not how many children
 * are in it, not whether it is over capacity or has no form teacher. Those are the
 * facts here, and all of them arrive from grouped queries — the page costs the same
 * whether the school has six classes or sixty.
 *
 * Filtering is client-side ON PURPOSE: the whole (already bounded) set is present,
 * so filtering it locally is instant and cannot mislead by hiding rows the server
 * never sent. That reasoning stops holding the moment this list is capped — at
 * which point it needs the server-search treatment the people pickers use.
 */
export function ClassGrid({ classes, canEnrol }: { classes: Row[]; canEnrol: boolean }) {
  const [q, setQ] = React.useState("");
  const [only, setOnly] = React.useState<"all" | "attention">("all");

  // A class nobody is accountable for, or one holding more children than it is
  // meant to. Both are fixable today, which is what makes them worth surfacing.
  const needsAttention = (c: Row) => !c.supervisorId || (c.capacity != null && c.students > c.capacity);

  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return classes
      .filter((c) => (only === "attention" ? needsAttention(c) : true))
      .filter(
        (c) =>
          !needle ||
          c.name.toLowerCase().includes(needle) ||
          (c.code ?? "").toLowerCase().includes(needle) ||
          (c.supervisorName ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => (a.level ?? 999) - (b.level ?? 999) || a.name.localeCompare(b.name));
  }, [classes, q, only]);

  const attention = classes.filter(needsAttention).length;
  const roll = classes.reduce((sum, c) => sum + c.students, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground tabular-nums">
          {classes.length} class{classes.length === 1 ? "" : "es"} · {roll} pupil{roll === 1 ? "" : "s"} enrolled
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by class, code or form teacher…"
            className="h-9 w-64"
            aria-label="Filter classes"
          />
          <div className="flex items-center gap-1 rounded-md border p-1">
            <Button size="sm" variant={only === "all" ? "default" : "ghost"} onClick={() => setOnly("all")}>
              All
            </Button>
            <Button
              size="sm"
              variant={only === "attention" ? "default" : "ghost"}
              onClick={() => setOnly("attention")}
              disabled={attention === 0}
            >
              Needs attention{attention > 0 ? ` (${attention})` : ""}
            </Button>
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {only === "attention" ? "Every class has a form teacher and is within capacity." : `No class matches “${q.trim()}”.`}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((c) => {
            const over = c.capacity != null && c.students > c.capacity;
            const full = c.capacity != null && !over && c.students >= c.capacity;
            return (
              <Card key={c.id} className="flex flex-col">
                <CardContent className="flex flex-1 flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{c.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {c.code ? <span className="font-mono">{c.code}</span> : null}
                        {c.code && c.level != null ? " · " : null}
                        {c.level != null ? `Level ${c.level}` : null}
                      </p>
                    </div>
                    {/* The roll is the headline number — it is what everything else
                        on this card is in service of. */}
                    <div className="text-right">
                      <p className={`text-2xl font-semibold tabular-nums ${over ? "text-destructive" : ""}`}>{c.students}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {c.capacity != null ? `of ${c.capacity}` : "pupils"}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    {c.supervisorName ? (
                      <span className="text-muted-foreground">Form teacher: {c.supervisorName}</span>
                    ) : (
                      // Not decoration: a class with no named form teacher is a class
                      // whose register nobody is responsible for taking.
                      <Badge variant="destructive">No form teacher</Badge>
                    )}
                    {over && <Badge variant="destructive">Over capacity</Badge>}
                    {full && <Badge variant="outline">Full</Badge>}
                  </div>

                  <p className="text-xs text-muted-foreground tabular-nums">
                    {c.teachers} teacher{c.teachers === 1 ? "" : "s"} · {c.subjects} subject{c.subjects === 1 ? "" : "s"}
                  </p>

                  <div className="mt-auto flex flex-wrap gap-2 pt-1">
                    <Link href={`/classes/${c.id}/info`} className={buttonVariants({ size: "sm", variant: "outline" })}>
                      Info
                    </Link>
                    {canEnrol && (
                      <Link href={`/classes/${c.id}/roster`} className={buttonVariants({ size: "sm", variant: "outline" })}>
                        Roster
                      </Link>
                    )}
                    <Link href={`/classes/${c.id}/content`} className={buttonVariants({ size: "sm", variant: "outline" })}>
                      Content
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
