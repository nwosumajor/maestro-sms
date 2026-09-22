"use client";

// =============================================================================
// Attaching the recording of a lesson that has happened — ONE control
// =============================================================================
// Three steps, and the middle one is the browser talking straight to the
// bucket: presign (what we will allow), PUT (the bytes, which the API never
// sees), confirm (what actually arrived). Nothing is attached until the server
// has looked at the bytes — an upload is a CLAIM until then, and a failed PUT
// that still said "Attached" is a defect this codebase has already met.
//
// IT LIVES HERE BECAUSE IT IS NEEDED IN TWO PLACES. It was written inside the
// per-class panel, which is reached by going Classes -> a class -> Learning
// content -> scroll. The page actually CALLED "Live classes", the one in the
// nav, listed every session including the ENDED ones — the exact rows that need
// a recording — showed whether each had one, and offered no way to add it: a
// teacher looking at the lesson they just taught got an em-dash. That is the
// "a control the product imposes must have a way to FINISH it" shape, and
// copying the three-step flow into the table would have been the "written six
// times, right five" shape one step later.
// =============================================================================

import * as React from "react";
import { MAX_RECORDING_BYTES } from "@sms/types";
import { interpretApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api/sms${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  const data = raw ? JSON.parse(raw) : null;
  if (res.ok) return { ok: true as const, data };
  const j = data as { message?: string | string[] } | null;
  return {
    ok: false as const,
    error: interpretApiError(res.status, Array.isArray(j?.message) ? j.message.join(", ") : j?.message),
  };
}

export function RecordingControl({
  sessionId,
  title,
  hasRecording,
  onChanged,
  /** `row` is the table cell: stacked, and it says what the size limit is only
   *  while idle so the column does not grow. `inline` is the panel's footer. */
  layout = "inline",
}: {
  sessionId: string;
  title: string;
  hasRecording: boolean;
  onChanged: () => void;
  layout?: "inline" | "row";
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setErr(null);
    setBusy("Preparing…");
    const pre = await req("POST", `/live/${sessionId}/recording/presign`, {
      fileName: file.name,
      contentType: file.type || "video/mp4",
      sizeBytes: file.size,
    });
    if (!pre.ok) {
      setBusy(null);
      setErr(pre.error);
      return;
    }
    const { url, key } = pre.data as { url: string; key: string };
    setBusy("Uploading…");
    // Straight to storage. A lecture is hundreds of megabytes and must never go
    // through the API — that is the whole point of a presigned PUT.
    const put = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type || "video/mp4" } });
    if (!put.ok) {
      setBusy(null);
      setErr("The upload did not finish. Please try again.");
      return;
    }
    setBusy("Checking…");
    const done = await req("POST", `/live/${sessionId}/recording/confirm`, { key });
    setBusy(null);
    if (!done.ok) {
      setErr(done.error);
      return;
    }
    onChanged();
  }

  async function remove() {
    setErr(null);
    setBusy("Removing…");
    const r = await req("DELETE", `/live/${sessionId}/recording`);
    setBusy(null);
    if (!r.ok) setErr(r.error);
    else onChanged();
  }

  const stacked = layout === "row";

  return (
    <div className={stacked ? "space-y-0.5" : "contents"}>
      {/* Hidden, and still NAMED: a screen reader announces the control the
          click opens, and "blank" is what an unlabelled file input reads as. */}
      <input
        ref={fileRef}
        type="file"
        accept="video/mp4"
        aria-label={`Attach a recording of ${title}`}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
      {hasRecording ? (
        <>
          {!stacked && <span className="text-muted-foreground">· recorded</span>}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-destructive"
            disabled={!!busy}
            onClick={() => void remove()}
          >
            {busy ?? "Remove recording"}
          </Button>
        </>
      ) : (
        <>
          <Button
            size="sm"
            variant={stacked ? "outline" : "ghost"}
            className="h-7"
            disabled={!!busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ?? "Attach recording"}
          </Button>
          {/* SAID BEFORE THE FILE IS CHOSEN, and derived from the same constant
              the server refuses on, so the screen cannot promise a size the API
              rejects. The teacher has already recorded by the time they get
              here, so the useful half of this is the RESOLUTION, not the
              number. */}
          {!busy && (
            <span className={stacked ? "block text-xs text-muted-foreground" : "text-muted-foreground"}>
              {stacked ? "" : "· "}MP4 up to {(MAX_RECORDING_BYTES / 1024 / 1024 / 1024).toFixed(1)} GB — record at 720p
            </span>
          )}
        </>
      )}
      {err && <span className={stacked ? "block text-xs text-destructive" : "text-destructive"}>{err}</span>}
    </div>
  );
}
