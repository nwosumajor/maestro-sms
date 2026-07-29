"use client";

import * as React from "react";
import type { CbtBankDto, CbtBankQuestionsDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Bank = Serialized<CbtBankDto>;
type Thread = Serialized<CbtBankQuestionsDto>;

/**
 * READ-ONLY oversight of question banks, for `cbt.review` holders (the head
 * teacher who approves CBT publishing). They see every bank in the school and can
 * read the questions to vet quality and coverage — but never the marked answer
 * key, and there are no authoring controls at all.
 */
export function CbtReviewPanel({ banks }: { banks: Bank[] }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Question banks — review</CardTitle>
          <CardDescription>
            Every bank in the school. Open one to read its questions before you approve an exam for publishing. Answer keys are
            not shown here — they stay with the subject teacher who authored them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {banks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No question banks have been created yet.</p>
          ) : (
            <ul className="space-y-3">
              {banks.map((b) => (
                <BankRow key={b.id} bank={b} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BankRow({ bank }: { bank: Bank }) {
  const [open, setOpen] = React.useState(false);
  const [thread, setThread] = React.useState<Thread | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (thread) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/sms/cbt/banks/${bank.id}/questions`);
    setBusy(false);
    if (!res.ok) {
      setErr(await readApiError(res));
      return;
    }
    setThread((await res.json()) as Thread);
  };

  return (
    <li className="rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{bank.name}</p>
          <p className="text-xs text-muted-foreground">
            {bank.subject ?? "No subject"} · {bank.questionCount} question{bank.questionCount === 1 ? "" : "s"}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void toggle()}>
          {open ? "Hide questions" : "Read questions"}
        </Button>
      </div>

      {open && (
        <div className="mt-3 border-t pt-3">
          {busy && <p className="text-sm text-muted-foreground">Loading questions…</p>}
          {err && <p className="text-sm text-destructive">{err}</p>}
          {thread && thread.questions.length === 0 && (
            <p className="text-sm text-muted-foreground">This bank has no questions yet.</p>
          )}
          {thread && thread.questions.length > 0 && (
            <>
              <Badge variant="outline" className="mb-2">
                Answer key hidden for review
              </Badge>
              <ol className="space-y-3">
                {thread.questions.map((q, i) => (
                  <li key={q.id} className="text-sm">
                    <p className="font-medium">
                      {i + 1}. {q.prompt}
                    </p>
                    <ul className="mt-1 space-y-0.5 pl-4 text-muted-foreground">
                      {q.choices.map((c, ci) => (
                        <li key={ci}>
                          {String.fromCharCode(65 + ci)}. {c}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </li>
  );
}
