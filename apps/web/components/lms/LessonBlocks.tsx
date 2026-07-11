// =============================================================================
// LessonBlocks — render a lesson's structured blocks (safe, no raw HTML)
// =============================================================================
// Every text field comes from the API as plain text and is rendered as a React
// child, so it is auto-escaped — there is no dangerouslySetInnerHTML anywhere in
// the lesson path. This is the defense-in-depth replacement for the old free-form
// HTML lesson body (which trusted only the approval gate). Math blocks show the
// TeX source in a styled box; a KaTeX visual pass is a future enhancement.
// =============================================================================

import type { LessonBlock } from "@sms/types";

const TONE: Record<string, string> = {
  info: "border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40",
  warn: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",
  tip: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40",
};

export function LessonBlocks({ blocks }: { blocks: LessonBlock[] }) {
  if (!blocks || blocks.length === 0) {
    return <p className="text-sm text-muted-foreground">This lesson has no content yet.</p>;
  }
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "heading":
            return b.level === 3 ? (
              <h4 key={i} className="mt-2 text-base font-semibold tracking-tight">
                {b.text}
              </h4>
            ) : (
              <h3 key={i} className="mt-3 text-lg font-semibold tracking-tight">
                {b.text}
              </h3>
            );
          case "paragraph":
            return (
              <p key={i} className="whitespace-pre-wrap">
                {b.text}
              </p>
            );
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 pl-3 italic text-muted-foreground">
                {b.text}
              </blockquote>
            );
          case "callout":
            return (
              <div key={i} className={`rounded-md border px-3 py-2 ${TONE[b.tone] ?? TONE.info}`}>
                <span className="whitespace-pre-wrap">{b.text}</span>
              </div>
            );
          case "bullets":
            return (
              <ul key={i} className="list-disc space-y-1 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{it}</li>
                ))}
              </ul>
            );
          case "numbered":
            return (
              <ol key={i} className="list-decimal space-y-1 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{it}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre key={i} className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                {b.lang && <div className="mb-1 text-[10px] uppercase text-muted-foreground">{b.lang}</div>}
                <code>{b.code}</code>
              </pre>
            );
          case "math":
            return (
              <div
                key={i}
                className="overflow-x-auto rounded-md border border-dashed bg-muted/40 px-3 py-2 text-center font-mono text-sm"
                aria-label="math expression"
              >
                {b.tex}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
