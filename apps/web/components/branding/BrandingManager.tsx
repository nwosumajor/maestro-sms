"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { SchoolBrandingDto, BrandingUploadTargetDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function BrandingManager({ initial, slug }: { initial: Serialized<SchoolBrandingDto>; slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) { setMsg("Choose an image first."); return; }
    setBusy(true); setMsg(null);
    // 1) ask the API for a presigned upload target (records the logo key).
    const res = await fetch("/api/sms/schools/branding/logo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: file.type }),
    });
    if (!res.ok) { setBusy(false); setMsg(`Failed (${res.status}). Allowed: PNG/JPEG/SVG/WebP.`); return; }
    const { uploadUrl } = (await res.json()) as BrandingUploadTargetDto;
    // 2) upload the bytes directly to storage.
    try {
      const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      setMsg(put.ok ? "Logo uploaded." : "Logo recorded, but the storage upload failed (local stub has no real bucket).");
    } catch {
      setMsg("Logo recorded, but the storage upload failed (local stub has no real bucket).");
    }
    setBusy(false);
    router.refresh();
  };

  const remove = async () => {
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/schools/branding/logo", { method: "DELETE" });
    setBusy(false);
    setMsg(res.ok ? "Logo removed." : `Failed (${res.status}).`);
    router.refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Login-page logo</CardTitle>
        <CardDescription>
          Shown on your school&apos;s branded login page (<span className="font-mono">/login?school={slug}</span>).
          Hidden automatically while the subscription is lapsed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {initial.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- tenant logo from storage
          <img src={initial.logoUrl} alt="School logo" className="h-20 w-20 rounded-md border border-border object-contain" />
        ) : (
          <p className="text-sm text-muted-foreground">No logo set.</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="text-sm" />
          <Button size="sm" disabled={busy} onClick={upload}>{busy ? "Uploading…" : "Upload"}</Button>
          {initial.logoKey && <Button size="sm" variant="outline" disabled={busy} onClick={remove}>Remove</Button>}
        </div>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
