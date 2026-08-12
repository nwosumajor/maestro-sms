"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { readApiError } from "@/lib/api-error";
import { StudentExitDialog } from "./StudentExitDialog";

type Student = { id: string; name: string; email: string };

export function RosterStudents({
  classId,
  students,
  canWrite,
  canRequestExit,
}: {
  classId: string;
  students: Student[];
  canWrite: boolean;
  /** Whether this staff member may raise a school exit (stage 1 of two). */
  canRequestExit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [exiting, setExiting] = React.useState<Student | null>(null);

  /**
   * Take a pupil out of THIS class only.
   *
   * This is a roster correction — wrong class, wrong arm — and it is what the
   * endpoint has always done. It is NOT "the child left the school": their
   * account stays active and every other class keeps them. The old buttons said
   * "Transfer" and "Withdraw", which read like leaving, and that mismatch is
   * why nothing ever actually revoked access. The API now refuses this on a
   * pupil's LAST class and points here, at the exit request.
   */
  const removeFromClass = async (studentId: string) => {
    const reason = window.prompt("Why is this student being taken off this class list?") ?? undefined;
    setBusy(studentId);
    setMsg(null);
    const res = await fetch(`/api/sms/classes/${classId}/enrollments/${studentId}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "TRANSFERRED", reason }),
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
          <div className="flex gap-1.5">
            {canWrite && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                disabled={busy === s.id}
                onClick={() => removeFromClass(s.id)}
                title="Remove from this class list only — does not affect their access"
              >
                Remove from class
              </Button>
            )}
            {canRequestExit && (
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setExiting(s)}>
                Left the school…
              </Button>
            )}
          </div>
        </div>
      ))}

      {exiting && (
        <StudentExitDialog
          studentId={exiting.id}
          studentName={exiting.name}
          onClose={() => setExiting(null)}
        />
      )}
    </div>
  );
}
