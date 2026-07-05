"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  WORKFLOW_PERMISSIONS,
  WORKFLOW_TRANSITIONS,
  WORKFLOW_TYPES,
  WORKFLOW_TYPE_META,
  SPECIAL_REQUEST_CATEGORIES,
  canInitiateWorkflowType,
  type SpecialRequestCategory,
  type WorkflowApproverOptionDto,
  type WorkflowState,
  type WorkflowType,
  type WorkflowInboxItemDto,
  type Serialized,
} from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type WorkflowDto = Serialized<WorkflowInboxItemDto>;

const STATE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  DRAFT: "outline",
  PENDING_REVIEW: "default",
  REVISION_REQUESTED: "secondary",
  APPROVED: "default",
  REJECTED: "destructive",
};

export function WorkflowInbox({
  initial,
  userId,
  permissions,
}: {
  initial: WorkflowDto[];
  userId: string;
  permissions: string[];
}) {
  const router = useRouter();
  const has = (p: string) => permissions.includes(p);
  const canCreate = has(WORKFLOW_PERMISSIONS.CREATE);
  const canReview = has(WORKFLOW_PERMISSIONS.REVIEW);
  const canVeto = has(WORKFLOW_PERMISSIONS.VETO);

  const [type, setType] = React.useState<WorkflowType>("STAFF_REQUEST");
  const [title, setTitle] = React.useState("");
  const [category, setCategory] = React.useState<SpecialRequestCategory>("EQUIPMENT");
  const [details, setDetails] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Only the types this user may initiate (PO needs finance, disciplinary needs
  // rbac.manage, content-publish is system-only).
  const initiatableTypes = WORKFLOW_TYPES.filter((t) => canInitiateWorkflowType(t, permissions));

  // Optional initiator routing: pick 2–3 named senior staff as the approval
  // chain. Empty = the type's default route. The API re-validates everything
  // (distinct, reviewer-capable, never the initiator).
  const [approverOptions, setApproverOptions] = React.useState<Serialized<WorkflowApproverOptionDto>[]>([]);
  const [route, setRoute] = React.useState<string[]>(["", "", ""]);
  React.useEffect(() => {
    if (!canCreate) return;
    let live = true;
    fetch("/api/sms/workflows/approvers")
      .then((r) => (r.ok ? r.json() : []))
      .then((opts: Serialized<WorkflowApproverOptionDto>[]) => { if (live) setApproverOptions(opts); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [canCreate]);
  const pickedRoute = route.filter(Boolean);

  // All mutating calls go through the same-origin BFF, which injects the Bearer.
  const call = async (path: string, body: unknown, key: string) => {
    setBusy(key);
    setError(null);
    const res = await fetch(`/api/sms/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(null);
    if (!res.ok) {
      setError(
        res.status === 409
          ? "That action isn't allowed from the request's current state."
          : res.status === 403
            ? "You can't take that action (insufficient permission, or you initiated it)."
            : `Request failed (${res.status}).`,
      );
      return;
    }
    router.refresh();
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const isSpecial = type === "STAFF_REQUEST";
    const finalTitle =
      title.trim() || (isSpecial ? `${category.replace(/_/g, " ").toLowerCase()} request` : "");
    if (!finalTitle) return;
    if (pickedRoute.length === 1) {
      setError("A routed approval needs at least 2 approvers (or leave routing empty for the default).");
      return;
    }
    if (new Set(pickedRoute).size !== pickedRoute.length) {
      setError("Each approval stage must be a different person.");
      return;
    }
    const payload = isSpecial ? { category, details: details.trim() } : {};
    await call(
      "workflows",
      { type, title: finalTitle, payload, ...(pickedRoute.length >= 2 ? { approverIds: pickedRoute } : {}) },
      "create",
    );
    setTitle("");
    setDetails("");
    setRoute(["", "", ""]);
  };

  // Which transitions are legal from this state, given the actor's permissions
  // and separation of duties. The API re-checks all of this.
  function actionsFor(w: WorkflowDto): { action: string; label: string; variant?: "default" | "destructive" | "outline"; run: () => void }[] {
    const legal = WORKFLOW_TRANSITIONS[w.state as WorkflowState] ?? {};
    const isInitiator = w.initiatorId === userId;
    const out: ReturnType<typeof actionsFor> = [];

    if ("SUBMIT" in legal && canCreate && isInitiator) {
      out.push({
        action: "SUBMIT",
        label: "Submit for review",
        run: () => call(`workflows/${w.id}/submit`, {}, `${w.id}:submit`),
      });
    }
    if (canReview && !isInitiator && w.state === "PENDING_REVIEW") {
      out.push({
        action: "APPROVE",
        label: "Approve",
        run: () => call(`workflows/${w.id}/review`, { action: "APPROVE" }, `${w.id}:approve`),
      });
      out.push({
        action: "REQUEST_REVISION",
        label: "Request revision",
        variant: "outline",
        run: () =>
          call(`workflows/${w.id}/review`, { action: "REQUEST_REVISION" }, `${w.id}:revise`),
      });
      out.push({
        action: "REJECT",
        label: "Reject",
        variant: "destructive",
        run: () => call(`workflows/${w.id}/review`, { action: "REJECT" }, `${w.id}:reject`),
      });
    }
    if ("VETO" in legal && canVeto && w.state === "APPROVED") {
      out.push({
        action: "VETO",
        label: "Veto",
        variant: "destructive",
        run: () => call(`workflows/${w.id}/veto`, {}, `${w.id}:veto`),
      });
    }
    return out;
  }

  return (
    <div className="space-y-6">
      {canCreate && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New request</CardTitle>
            <CardDescription>Creates a DRAFT you then submit for review.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={create} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="wf-type">Type</Label>
                <select
                  id="wf-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as WorkflowType)}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  {initiatableTypes.map((t) => (
                    <option key={t} value={t}>
                      {WORKFLOW_TYPE_META[t].label}
                    </option>
                  ))}
                </select>
              </div>
              {type === "STAFF_REQUEST" && (
                <div className="space-y-1.5">
                  <Label htmlFor="wf-cat">Category</Label>
                  <select
                    id="wf-cat"
                    value={category}
                    onChange={(e) => setCategory(e.target.value as SpecialRequestCategory)}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {SPECIAL_REQUEST_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="wf-title">Title</Label>
                <Input
                  id="wf-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={type === "STAFF_REQUEST" ? "Optional — defaults from category" : "e.g. Annual leave — 3 days"}
                />
              </div>
              {type === "STAFF_REQUEST" && (
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="wf-details">Details</Label>
                  <Input
                    id="wf-details"
                    value={details}
                    onChange={(e) => setDetails(e.target.value)}
                    placeholder="What you need and why"
                  />
                </div>
              )}
              <Button type="submit" disabled={busy === "create"}>
                {busy === "create" ? "Creating…" : "Create"}
              </Button>
            </form>

            {approverOptions.length > 0 && (
              <div className="mt-4 space-y-2 border-t border-border pt-4">
                <Label>Route approvals to (optional)</Label>
                <p className="text-xs text-muted-foreground">
                  Pick 2 or 3 senior staff to approve in order — each stage must be a different
                  person, and you can&apos;t pick yourself. Leave empty to use the standard route.
                  The principal and school administrator can see every request either way.
                </p>
                <div className="flex flex-wrap gap-2">
                  {[0, 1, 2].map((i) => (
                    <select
                      key={i}
                      aria-label={`Approval stage ${i + 1}`}
                      value={route[i]}
                      onChange={(e) => setRoute((r) => r.map((v, j) => (j === i ? e.target.value : v)))}
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">{i < 2 ? `Stage ${i + 1}…` : "Stage 3 (optional)…"}</option>
                      {approverOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name} ({o.roles.join(", ").replace(/_/g, " ")})
                        </option>
                      ))}
                    </select>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {initial.length === 0 ? (
        <p className="text-sm text-muted-foreground">No requests yet.</p>
      ) : (
        <div className="space-y-3">
          {initial.map((w) => {
            const actions = actionsFor(w);
            return (
              <Card key={w.id}>
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                  <div>
                    <CardTitle className="text-base">{w.title}</CardTitle>
                    <CardDescription>
                      {w.type.replace("_", " ")} ·{" "}
                      {w.initiatorId === userId ? "you initiated" : "from a colleague"}
                    </CardDescription>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge variant={STATE_VARIANT[w.state] ?? "secondary"}>
                      {w.state.replace("_", " ")}
                    </Badge>
                    {w.stageCount > 0 && w.state === "PENDING_REVIEW" && (
                      <span className="text-xs text-muted-foreground">
                        Stage {w.currentStage + 1}/{w.stageCount}
                        {w.stageLabel ? ` · ${w.stageLabel}` : ""}
                      </span>
                    )}
                  </div>
                </CardHeader>
                {actions.length > 0 && (
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {actions.map((a) => (
                        <Button
                          key={a.action}
                          size="sm"
                          variant={a.variant ?? "default"}
                          disabled={busy?.startsWith(w.id)}
                          onClick={a.run}
                        >
                          {a.label}
                        </Button>
                      ))}
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
