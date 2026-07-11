"use client";

// =============================================================================
// LessonBlockEditor — author a lesson as structured, plain-text blocks (client)
// =============================================================================
// Produces a LessonBlock[] that the API re-validates/normalises server-side.
// No HTML is authored or stored — the render path (LessonBlocks) auto-escapes
// every field, so this is the defense-in-depth replacement for the old free-form
// HTML lesson body. Bullet/numbered items are edited one-per-line.
// =============================================================================

import type { LessonBlock, LessonBlockType } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const TYPES: { value: LessonBlockType; label: string }[] = [
  { value: "heading", label: "Heading" },
  { value: "paragraph", label: "Paragraph" },
  { value: "bullets", label: "Bulleted list" },
  { value: "numbered", label: "Numbered list" },
  { value: "callout", label: "Callout" },
  { value: "quote", label: "Quote" },
  { value: "code", label: "Code" },
  { value: "math", label: "Math (TeX)" },
];

function blank(type: LessonBlockType): LessonBlock {
  switch (type) {
    case "heading":
      return { type: "heading", text: "", level: 2 };
    case "bullets":
      return { type: "bullets", items: [] };
    case "numbered":
      return { type: "numbered", items: [] };
    case "callout":
      return { type: "callout", text: "", tone: "info" };
    case "quote":
      return { type: "quote", text: "" };
    case "code":
      return { type: "code", code: "" };
    case "math":
      return { type: "math", tex: "" };
    default:
      return { type: "paragraph", text: "" };
  }
}

const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";

export function LessonBlockEditor({
  blocks,
  onChange,
}: {
  blocks: LessonBlock[];
  onChange: (b: LessonBlock[]) => void;
}) {
  const [adding, setAdding] = React.useState<LessonBlockType>("paragraph");

  const update = (i: number, next: LessonBlock) => onChange(blocks.map((b, j) => (j === i ? next : b)));
  const remove = (i: number) => onChange(blocks.filter((_, j) => j !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const copy = [...blocks];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  };
  const add = () => onChange([...blocks, blank(adding)]);

  return (
    <div className="space-y-2">
      {blocks.length === 0 && (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          No blocks yet. Add a heading, paragraph, list, callout, code or math block below.
        </p>
      )}
      {blocks.map((b, i) => (
        <div key={i} className="rounded-md border p-2">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-xs font-medium uppercase text-muted-foreground">{b.type}</span>
            {b.type === "heading" && (
              <select
                aria-label="Heading level"
                className={sel + " h-7"}
                value={b.level}
                onChange={(e) => update(i, { ...b, level: Number(e.target.value) === 3 ? 3 : 2 })}
              >
                <option value={2}>H2</option>
                <option value={3}>H3</option>
              </select>
            )}
            {b.type === "callout" && (
              <select
                aria-label="Callout tone"
                className={sel + " h-7"}
                value={b.tone}
                onChange={(e) => update(i, { ...b, tone: e.target.value as "info" | "warn" | "tip" })}
              >
                <option value="info">Info</option>
                <option value="tip">Tip</option>
                <option value="warn">Warning</option>
              </select>
            )}
            {b.type === "code" && (
              <Input
                aria-label="Code language"
                className="h-7 w-28"
                placeholder="lang"
                value={b.lang ?? ""}
                onChange={(e) => update(i, { ...b, lang: e.target.value || undefined })}
              />
            )}
            <div className="ml-auto flex items-center gap-1">
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => move(i, -1)} disabled={i === 0}>
                ↑
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => move(i, 1)}
                disabled={i === blocks.length - 1}
              >
                ↓
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => remove(i)}>
                ✕
              </Button>
            </div>
          </div>
          {b.type === "heading" && (
            <Input value={b.text} placeholder="Heading text" onChange={(e) => update(i, { ...b, text: e.target.value })} />
          )}
          {b.type === "paragraph" && (
            <Textarea rows={3} value={b.text} placeholder="Paragraph text" onChange={(e) => update(i, { ...b, text: e.target.value })} />
          )}
          {b.type === "quote" && (
            <Textarea rows={2} value={b.text} placeholder="Quoted text" onChange={(e) => update(i, { ...b, text: e.target.value })} />
          )}
          {b.type === "callout" && (
            <Textarea rows={2} value={b.text} placeholder="Callout text" onChange={(e) => update(i, { ...b, text: e.target.value })} />
          )}
          {b.type === "code" && (
            <Textarea
              rows={4}
              className="font-mono text-xs"
              value={b.code}
              placeholder="Code…"
              onChange={(e) => update(i, { ...b, code: e.target.value })}
            />
          )}
          {b.type === "math" && (
            <Textarea
              rows={2}
              className="font-mono text-xs"
              value={b.tex}
              placeholder="TeX, e.g. E = mc^2"
              onChange={(e) => update(i, { ...b, tex: e.target.value })}
            />
          )}
          {(b.type === "bullets" || b.type === "numbered") && (
            <Textarea
              rows={3}
              value={b.items.join("\n")}
              placeholder="One item per line"
              onChange={(e) => update(i, { ...b, items: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
            />
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <select aria-label="Block type" className={sel} value={adding} onChange={(e) => setAdding(e.target.value as LessonBlockType)}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <Button type="button" size="sm" variant="outline" onClick={add}>
          + Add block
        </Button>
      </div>
    </div>
  );
}
