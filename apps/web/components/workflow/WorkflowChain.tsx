"use client";

// WHO approved WHICH stage — and whether they normally could.
//
// `GET /workflows/:id` has always returned the approval chain and the immutable
// audit trail, and NO PAGE CALLED IT. A school could see that a leave request,
// a salary change, a fee run or an admin appointment was pending, and act on
// it, but could never afterwards see who decided what. A maker-checker record
// that cannot be read is most of the way to not having one.
//
// The line this exists for is `viaElevation`. The engine records it on every
// approval — "the trail should show that a stand-in decided it, not merely
// who", says the comment where it is written — into a JSON column nothing read.
// A stage approved under a temporary grant looked exactly like one approved by
// the person who holds that authority every day.

import type { Serialized, WorkflowDetailDto } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { useFormat } from "@/components/shell/RegionProvider";

type Detail = Serialized<WorkflowDetailDto>;

export function WorkflowChain({ requestId }: { requestId: string }) {
  const [open, setOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [failed, setFailed] = React.useState(false);
  const { dateTime } = useFormat();

  React.useEffect(() => {
    if (!open || detail || failed) return;
    void (async () => {
      const res = await fetch(`/api/sms/workflows/${requestId}`, { cache: "no-store" });
      // A failed read is not an empty chain — saying "no approvals" about a
      // request that has them would be worse than saying nothing.
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setDetail((await res.json()) as Detail);
    })();
  }, [open, detail, failed, requestId]);

  return (
    <div className="mt-2">
      <button
        type="button"
        className="text-xs text-muted-foreground underline hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide approval history" : "Approval history"}
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-border p-3 text-sm">
          {failed && <p className="text-muted-foreground">Couldn&rsquo;t load the approval history.</p>}
          {!failed && !detail && <p className="text-muted-foreground">Loading…</p>}
          {detail && (
            <>
              <p className="text-xs text-muted-foreground">
                Raised by {detail.initiatorName} · {dateTime(detail.createdAt)}
              </p>
              {detail.stages.length > 0 ? (
                <ol className="mt-2 space-y-1.5">
                  {detail.stages.map((s, i) => (
                    <li key={s.key} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-xs text-muted-foreground">{i + 1}.</span>
                      <span className="font-medium">{s.label}</span>
                      {s.decidedBy ? (
                        <>
                          <span className="text-muted-foreground">
                            — {s.decidedBy.approverName}, {dateTime(s.decidedBy.at)}
                          </span>
                          {/* The whole point. A stage decided by a stand-in is
                              not the same fact as one decided by the person
                              who holds that authority. */}
                          {s.decidedBy.viaElevation && (
                            <Badge variant="outline" className="font-normal">
                              under temporary elevation
                            </Badge>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">
                          — awaiting{s.routedToName ? ` ${s.routedToName}` : ""}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-muted-foreground">Single-stage request.</p>
              )}
              {detail.trail.length > 0 && <WorkflowTrail trail={detail.trail} dateTime={dateTime} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The immutable trail, one line per transition.
 *
 * Its own component so it can be DRIVEN: the bug it exists to prevent was a
 * render-time throw that no server-side check could see. `/workflows` returned
 * 200 for every role under 24 filter combinations, every asset loaded, and the
 * API returned 200 for the list and for each request's detail — and expanding
 * this section still replaced the page with "This page could not be loaded".
 */
export function WorkflowTrail({
  trail,
  dateTime,
}: {
  trail: Array<{ at: string; actorName: string | null; oldState: string | null; newState: string; comments: string | null }>;
  dateTime: (v: string) => string;
}) {
  const words = (s: string) => s.replace(/_/g, " ");
  return (
    <ul className="mt-3 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
      {trail.map((t, i) => (
        <li key={i}>
          {dateTime(t.at)} ·{" "}
          {/* NO PREVIOUS STATE IS NOT A STATE CALLED "null". The creation row
              has none, so it reads as an arrival rather than a transition. */}
          {t.oldState ? `${words(t.oldState)} → ` : ""}
          {words(t.newState)}
          {t.actorName ? ` · ${t.actorName}` : ""}
          {t.comments ? ` · ${t.comments}` : ""}
        </li>
      ))}
    </ul>
  );
}
