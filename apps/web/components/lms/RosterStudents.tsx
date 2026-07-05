"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { readApiError } from "@/lib/api-error";

type Student = { id: string; name: string; email: string };

export function RosterStudents({
  classId,
  students,
  canWrite,
}: {
  classId: string;
  students: Student[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const act = async (studentId: string, status: "TRANSFERRED" | "WITHDRAWN") => {
    const reason = window.prompt(`Reason for ${status.toLowerCase()}?`) ?? undefined;
    setBusy(studentId);
    setMsg(null);
    const res = await fetch(`/api/sms/classes/${classId}/enrollments/${studentId}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, reason }),
    });
    setBusy(null);
    if (res.ok) router.refresh();
    else setMsg(await readApiError(res));
  };

  return (
    <div className="space-y-1.5">
      {msg && <p className="text-sm text-destructive">{msg}</p>}
      {students.length === 0 && <p className="text-sm text-muted-foreground">No students enrolled.</p>}
      {students.map((s, i) => (
        <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
          <div className="flex items-center gap-3">
            <span className="w-6 text-right text-xs text-muted-foreground">{i + 1}</span>
            <span className="font-medium">{s.name}</span>
            <span className="text-muted-foreground">{s.email}</span>
          </div>
          {canWrite && (
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" className="h-7" disabled={busy === s.id} onClick={() => act(s.id, "TRANSFERRED")}>Transfer</Button>
              <Button size="sm" variant="ghost" className="h-7" disabled={busy === s.id} onClick={() => act(s.id, "WITHDRAWN")}>Withdraw</Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
