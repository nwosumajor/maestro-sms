"use client";

import * as React from "react";
import type { OperatorStudentDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";

type Student = Serialized<OperatorStudentDto>;

export function OperatorStudents({ schoolId }: { schoolId: string }) {
  const [open, setOpen] = React.useState(false);
  const [students, setStudents] = React.useState<Student[] | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && students === null) {
      const res = await fetch(`/api/sms/operator/tenants/${schoolId}/students`);
      if (res.ok) setStudents((await res.json()) as Student[]);
      else setNote(`Could not load students (${res.status}).`);
    }
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      <button onClick={toggle} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
        {open ? "Hide students" : "View students"}
      </button>
      {note && <p className="mt-2 rounded-md bg-muted px-3 py-2 text-xs font-mono">{note}</p>}
      {open && students && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs text-muted-foreground">{students.length} student account{students.length === 1 ? "" : "s"}</p>
          {students.length === 0 && <p className="text-sm text-muted-foreground">No student accounts in this school yet.</p>}
          {students.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5">
              <p className="truncate text-sm">
                {s.name} <span className="text-muted-foreground">· {s.email}</span>
                <span className="ml-2 font-mono text-[10px] text-muted-foreground">{s.uniqueId}</span>
                {s.admissionNumber && <span className="ml-2 font-mono text-xs text-muted-foreground">#{s.admissionNumber}</span>}
              </p>
              <div className="flex flex-wrap gap-1">
                {s.classes.length === 0 && <Badge variant="outline" className="text-[10px] text-muted-foreground">not enrolled yet</Badge>}
                {s.classes.map((c, i) => <Badge key={i} variant="outline" className="text-[10px]">{c}</Badge>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
