"use client";

// =============================================================================
// ApprovalQueue — principal reviews pending LMS content (client)
// =============================================================================
// Display only: the API re-checks the lms.content.approve permission and the
// workflow engine enforces separation of duties (approver != author). Each
// decision (APPROVE/REJECT/REQUEST_REVISION) drives the linked WorkflowRequest
// and reflects onto the content status; mutations are audited server-side.
// =============================================================================

import type { LmsContentDto, Serialized } from "@sms/types";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Content = Serialized<LmsContentDto>;

async function review(id: string, action: "APPROVE" | "REJECT" | "REQUEST_REVISION") {
  const res = await fetch(`/api/sms/content/${id}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (res.ok) return null;
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { message?: string | string[] };
    if (j.message) return Array.isArray(j.message) ? j.message.join(", ") : j.message;
  } catch {
    /* fall through */
  }
  return `Failed (${res.status}).`;
}

export function ApprovalQueue({ initial }: { initial: Content[] }) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);

  const act = async (id: string, action: "APPROVE" | "REJECT" | "REQUEST_REVISION", ok: string) => {
    const err = await review(id, action);
    setMsg(err ?? ok);
    if (!err) router.refresh();
  };

  if (initial.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing awaiting approval.</p>;
  }

  return (
    <div className="space-y-3">
      {initial.map((c) => (
        <Card key={c.id}>
          <CardHeader>
            <CardTitle className="text-base">
              <Link href={`/content/${c.id}`} className="hover:underline">
                {c.title}
              </Link>
            </CardTitle>
            <CardDescription>
              {c.type.replace(/_/g, " ").toLowerCase()} · by {c.authorName}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Link
              href={`/content/${c.id}`}
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Review
            </Link>
            <Button size="sm" onClick={() => act(c.id, "APPROVE", "Published.")}>
              Approve &amp; publish
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => act(c.id, "REQUEST_REVISION", "Revision requested.")}
            >
              Request revision
            </Button>
            <Button size="sm" variant="destructive" onClick={() => act(c.id, "REJECT", "Rejected.")}>
              Reject
            </Button>
          </CardContent>
        </Card>
      ))}
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}
