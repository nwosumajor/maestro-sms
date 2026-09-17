"use client";

import * as React from "react";
import type { PublicSchoolDto } from "@sms/types";
import { formatMoney } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const MAX_SCHOOLS = 2;

/**
 * The SCHOOL's own currency, scaled by that currency.
 *
 * This is a PUBLIC, pre-auth page — there is no session to read a region from,
 * so the currency has to travel with the school. It rendered every fee as
 * `en-NG` naira divided by 100, which for a Ghanaian school named the wrong
 * currency and for a francophone one showed a hundredth of the fee, on the
 * screen a family reads before deciding whether they can afford to apply.
 */
const fee = (s: PublicSchoolDto) => formatMoney(s.admissionFormFeeMinor, s.currency || "NGN", "en");

/**
 * A SEARCHABLE chooser, not the whole fleet.
 *
 * This was handed EVERY active school and rendered a checkbox for each. At
 * 5,003 schools that is 678 KB of markup and a form nobody can use — a family
 * does not find their child's school by scrolling five thousand checkboxes.
 *
 * `seed` is the first page (the common case: a small platform, or a family that
 * arrived from a school's own link). Typing searches the SAME paged endpoint the
 * directory uses, so the reach is the whole fleet while the payload stays one
 * page. A school chosen by search is REMEMBERED, so it survives the next query
 * clearing the results — the picker defect this repo has already recorded twice.
 */
export function EnrollForm({
  schools,
  total,
  preselect,
}: {
  schools: PublicSchoolDto[];
  total: number;
  preselect?: string;
}) {
  const [seed] = React.useState<PublicSchoolDto[]>(schools);
  const [results, setResults] = React.useState<PublicSchoolDto[] | null>(null);
  const [q, setQ] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  /** Schools the family has actually chosen — held so a name never vanishes. */
  const [picked, setPicked] = React.useState<PublicSchoolDto[]>(
    preselect ? schools.filter((s) => s.slug === preselect) : [],
  );
  const [selected, setSelected] = React.useState<string[]>(
    preselect && schools.some((s) => s.slug === preselect) ? [preselect] : [],
  );

  React.useEffect(() => {
    const needle = q.trim();
    if (!needle) { setResults(null); return; }
    let live = true;
    // Debounced: typing a name is one request, not one per keystroke.
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/public/schools?q=${encodeURIComponent(needle)}`, { cache: "no-store" });
        const body = res.ok ? ((await res.json()) as { items?: PublicSchoolDto[] }) : null;
        if (live) setResults(body?.items ?? []);
      } catch {
        if (live) setResults([]);
      } finally {
        if (live) setSearching(false);
      }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  // What to show: the search results when searching, otherwise the seed — with
  // anything already CHOSEN pinned on, so a selection made under a previous
  // query is never silently dropped from the list it is ticked in.
  const shown = React.useMemo(() => {
    const base = results ?? seed;
    const extra = picked.filter((p) => !base.some((b) => b.slug === p.slug));
    return [...extra, ...base];
  }, [results, seed, picked]);
  const [f, setF] = React.useState({
    parentName: "",
    parentEmail: "",
    parentPhone: "",
    parentAddress: "",
    relationship: "",
    childName: "",
    childDob: "",
    childGender: "",
    desiredClass: "",
    priorSchool: "",
    notes: "",
  });
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<string[] | null>(null);
  const [payLinks, setPayLinks] = React.useState<{ slug: string; url: string }[]>([]);
  const [err, setErr] = React.useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  const toggle = (school: PublicSchoolDto) => {
    const slug = school.slug;
    setSelected((cur) => {
      if (cur.includes(slug)) {
        setPicked((p) => p.filter((x) => x.slug !== slug));
        return cur.filter((s) => s !== slug);
      }
      if (cur.length >= MAX_SCHOOLS) return cur;
      setPicked((p) => (p.some((x) => x.slug === slug) ? p : [...p, school]));
      return [...cur, slug];
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selected.length === 0) {
      setErr("Please select at least one school.");
      return;
    }
    if (!f.parentName || !f.parentEmail || !f.childName) {
      setErr("Please complete the required fields.");
      return;
    }
    setBusy(true);
    setErr(null);
    const details = {
      parentName: f.parentName,
      parentEmail: f.parentEmail,
      parentPhone: f.parentPhone || null,
      parentAddress: f.parentAddress || null,
      relationship: f.relationship || null,
      childName: f.childName,
      childDob: f.childDob || null,
      childGender: f.childGender || null,
      desiredClass: f.desiredClass || null,
      priorSchool: f.priorSchool || null,
      notes: f.notes || null,
    };
    const ok: string[] = [];
    const feeLinks: { slug: string; url: string }[] = [];
    for (const slug of selected) {
      const res = await fetch("/api/public/admissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schoolSlug: slug,
          applicantName: f.parentName,
          applicantEmail: f.parentEmail,
          applicantPhone: f.parentPhone || null,
          childName: f.childName,
          childDob: f.childDob || null,
          desiredClass: f.desiredClass || null,
          notes: f.notes || null,
          details,
        }),
      });
      if (res.ok) {
        ok.push(slug);
        // A school may charge an admission-form fee — collect each pay link
        // (multi-school submit can't redirect to two checkouts at once).
        const data = (await res.json().catch(() => null)) as {
          payment?: { authorizationUrl: string } | null;
        } | null;
        if (data?.payment?.authorizationUrl) feeLinks.push({ slug, url: data.payment.authorizationUrl });
      }
    }
    setBusy(false);
    setPayLinks(feeLinks);
    if (ok.length === selected.length) setDone(ok);
    else setErr(`Submitted ${ok.length} of ${selected.length}. Please retry the rest.`);
  };

  if (done) {
    const names = [...picked, ...seed].filter((s) => done.includes(s.slug)).map((s) => s.name);
    return (
      <div className="space-y-3 text-sm">
        <p>
          Thank you — your enrolment application for <strong>{f.childName}</strong> has been submitted to{" "}
          {names.join(" and ")}. Each school will review it and email you the entrance-exam date once decided.
        </p>
        {payLinks.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="font-medium">One more step — admission form fee:</p>
            <ul className="mt-2 space-y-1.5">
              {payLinks.map((l) => {
                const school = schools.find((s) => s.slug === l.slug);
                return (
                  <li key={l.slug}>
                    <a href={l.url} className="text-primary underline underline-offset-2">
                      Pay {school?.name ?? l.slug}&apos;s form fee
                      {school && school.admissionFormFeeMinor > 0
                        ? ` (${fee(school)})`
                        : ""}
                    </a>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Your application is saved either way; the school sees it as unpaid until the fee settles.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <Label>Choose up to two schools</Label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {/* THE CONTROL REACHES PAST THE PAGE. Without it the list is the
              first fifty of however many schools the platform has, and a family
              whose school sorts later simply cannot apply. */}
          <div className="mb-2">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search for your school by name…"
              aria-label="Search for your school by name"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {searching
                ? "Searching…"
                : q.trim()
                  ? `${(results ?? []).length} matching “${q.trim()}”`
                  : `Showing ${seed.length} of ${total.toLocaleString()} schools — type to search them all.`}
            </p>
          </div>
          {shown.map((s) => {
            const on = selected.includes(s.slug);
            const disabled = !on && selected.length >= MAX_SCHOOLS;
            return (
              <label
                key={s.id}
                className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  on ? "border-primary bg-primary/5" : "border-border"
                } ${disabled ? "opacity-50" : ""}`}
              >
                <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(s)} />
                <span className="min-w-0">
                  {s.name}
                  {s.admissionFormFeeMinor > 0 && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      · form fee{" "}
                      {fee(s)}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium">Parent / guardian</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="e-pn">Full name *</Label><Input id="e-pn" value={f.parentName} onChange={set("parentName")} required /></div>
          <div className="space-y-1.5"><Label htmlFor="e-pe">Email *</Label><Input id="e-pe" type="email" value={f.parentEmail} onChange={set("parentEmail")} required /></div>
          <div className="space-y-1.5"><Label htmlFor="e-pp">Phone</Label><Input id="e-pp" value={f.parentPhone} onChange={set("parentPhone")} /></div>
          <div className="space-y-1.5"><Label htmlFor="e-rel">Relationship to child</Label><Input id="e-rel" value={f.relationship} onChange={set("relationship")} placeholder="Mother / Father / Guardian" /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="e-addr">Home address</Label><Input id="e-addr" value={f.parentAddress} onChange={set("parentAddress")} /></div>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium">Child</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="e-cn">Full name *</Label><Input id="e-cn" value={f.childName} onChange={set("childName")} required /></div>
          <div className="space-y-1.5"><Label htmlFor="e-dob">Date of birth</Label><Input id="e-dob" type="date" value={f.childDob} onChange={set("childDob")} /></div>
          <div className="space-y-1.5"><Label htmlFor="e-gen">Gender</Label><Input id="e-gen" value={f.childGender} onChange={set("childGender")} /></div>
          <div className="space-y-1.5"><Label htmlFor="e-cls">Desired class / grade</Label><Input id="e-cls" value={f.desiredClass} onChange={set("desiredClass")} placeholder="JSS1" /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="e-prior">Previous school</Label><Input id="e-prior" value={f.priorSchool} onChange={set("priorSchool")} /></div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="e-notes">Anything else (medical needs, notes)?</Label>
        <Textarea id="e-notes" rows={3} value={f.notes} onChange={set("notes")} />
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Submitting…" : `Submit application${selected.length > 1 ? "s" : ""}`}
      </Button>
    </form>
  );
}
