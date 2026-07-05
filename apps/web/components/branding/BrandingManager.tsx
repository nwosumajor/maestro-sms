"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { SchoolBrandingDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

const FONTS = ['"Inter", system-ui, sans-serif', '"Georgia", serif', '"Poppins", sans-serif', '"Roboto Slab", serif', '"system-ui", sans-serif'];

export function BrandingManager({ initial, slug }: { initial: Serialized<SchoolBrandingDto>; slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [hue, setHue] = React.useState(initial.brandHue ?? 243);
  const [sat, setSat] = React.useState(initial.brandSat ?? 75);
  const [light, setLight] = React.useState(initial.brandLight ?? 58);
  const [font, setFont] = React.useState(initial.fontFamily ?? FONTS[0]);

  const saveTheme = async () => {
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/schools/branding/theme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandHue: hue, brandSat: sat, brandLight: light, fontFamily: font }),
    });
    setBusy(false);
    setMsg(res.ok ? "Theme saved." : await readApiError(res));
    router.refresh();
  };

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) { setMsg("Choose an image first."); return; }
    if (file.type !== "image/png" && file.type !== "image/jpeg") { setMsg("Use a PNG or JPEG image."); return; }
    if (file.size > 1_000_000) { setMsg("Image must be under 1 MB."); return; }
    setBusy(true); setMsg(null);
    // Read the file as base64 and POST it — the API stores the bytes and embeds
    // the logo into generated certificates + report cards.
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    }).catch(() => "");
    if (!dataBase64) { setBusy(false); setMsg("Could not read the image."); return; }
    const res = await fetch("/api/sms/schools/branding/logo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: file.type, dataBase64 }),
    });
    setBusy(false);
    setMsg(res.ok ? "Logo uploaded — it now appears on the login page, certificates and report cards." : `Failed (${res.status}). Use a PNG/JPEG under 1 MB.`);
    router.refresh();
  };

  const remove = async () => {
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/schools/branding/logo", { method: "DELETE" });
    setBusy(false);
    setMsg(res.ok ? "Logo removed." : await readApiError(res));
    router.refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">School logo</CardTitle>
        <CardDescription>
          Appears on your branded login page (<span className="font-mono">/login?school={slug}</span>) and on generated
          certificates, ID cards and report cards. PNG or JPEG, under 1 MB.
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
          <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="text-sm" />
          <Button size="sm" disabled={busy} onClick={upload}>{busy ? "Uploading…" : "Upload"}</Button>
          {initial.logoKey && <Button size="sm" variant="outline" disabled={busy} onClick={remove}>Remove</Button>}
        </div>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>

      <CardHeader className="border-t border-border">
        <CardTitle className="text-base">Theme</CardTitle>
        <CardDescription>Pick your brand colour and font. Applied across your school&apos;s app.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label>Brand colour</Label>
            <div className="flex items-center gap-2">
              <input type="range" min={0} max={360} value={hue} onChange={(e) => setHue(Number(e.target.value))} />
              <span className="h-8 w-8 rounded-md border border-border" style={{ background: `hsl(${hue} ${sat}% ${light}%)` }} />
            </div>
          </div>
          <div className="space-y-1.5"><Label>Saturation</Label><Input className="w-20" type="number" min={0} max={100} value={sat} onChange={(e) => setSat(Number(e.target.value))} /></div>
          <div className="space-y-1.5"><Label>Lightness</Label><Input className="w-20" type="number" min={0} max={100} value={light} onChange={(e) => setLight(Number(e.target.value))} /></div>
          <div className="space-y-1.5">
            <Label>Font</Label>
            <select value={font} onChange={(e) => setFont(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm" style={{ fontFamily: font }}>
              {FONTS.map((fnt) => <option key={fnt} value={fnt} style={{ fontFamily: fnt }}>{fnt.split(",")[0].replace(/"/g, "")}</option>)}
            </select>
          </div>
          <Button size="sm" disabled={busy} onClick={saveTheme}>Save theme</Button>
        </div>
        <p className="text-sm" style={{ fontFamily: font, color: `hsl(${hue} ${sat}% ${light}%)` }}>Preview: The quick brown fox jumps over the lazy dog.</p>
      </CardContent>
    </Card>
  );
}
