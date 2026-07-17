// Minimal, dependency-free markdown renderer for the platform's own legal
// documents (docs/LEGAL.md content — trusted, first-party text). Supports the
// constructs those documents use: headings, paragraphs, lists, tables, block
// quotes, horizontal rules, and inline bold/code/links. NOT a general markdown
// engine — never point it at untrusted input.

import * as React from "react";

function inline(text: string, keyBase: string): React.ReactNode[] {
  // Tokenize bold, inline code, and links; everything else passes through.
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{tok.slice(1, -1)}</code>);
    else {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      out.push(
        <a key={key} href={link[2]} className="text-primary underline underline-offset-2">
          {link[1]}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function LegalMarkdown({ body }: { body: string }) {
  const lines = body.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const k = `b${key++}`;

    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("#### ")) {
      blocks.push(<h4 key={k} className="mt-6 text-base font-semibold tracking-tight">{inline(line.slice(5), k)}</h4>);
      i++;
    } else if (line.startsWith("### ")) {
      blocks.push(<h3 key={k} className="mt-8 text-lg font-semibold tracking-tight">{inline(line.slice(4), k)}</h3>);
      i++;
    } else if (line.startsWith("## ")) {
      blocks.push(<h2 key={k} className="mt-10 font-display text-2xl font-semibold tracking-tight">{inline(line.slice(3), k)}</h2>);
      i++;
    } else if (/^-{3,}\s*$/.test(line)) {
      blocks.push(<hr key={k} className="my-8 border-border" />);
      i++;
    } else if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
        quote.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={k} className="my-4 rounded-md border-l-4 border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm leading-relaxed">
          {inline(quote.join(" "), k)}
        </blockquote>,
      );
    } else if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
        const cells = (lines[i] ?? "").split("|").slice(1, -1).map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells); // skip the separator row
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={k} className="my-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            {head && (
              <thead>
                <tr className="border-b border-border text-left">
                  {head.map((c, ci) => <th key={ci} className="px-3 py-2 font-semibold">{inline(c, `${k}h${ci}`)}</th>)}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri} className="border-b border-border/60 last:border-0 align-top">
                  {r.map((c, ci) => <td key={ci} className="px-3 py-2">{inline(c, `${k}r${ri}c${ci}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^(-|\*)\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && (/^(-|\*)\s/.test(lines[i] ?? "") || /^\s{2,}\S/.test(lines[i] ?? ""))) {
        if (/^(-|\*)\s/.test(lines[i] ?? "")) items.push((lines[i] ?? "").replace(/^(-|\*)\s/, ""));
        else items[items.length - 1] += " " + (lines[i] ?? "").trim(); // continuation line
        i++;
      }
      blocks.push(
        <ul key={k} className="my-3 list-disc space-y-1.5 pl-6 text-sm leading-relaxed">
          {items.map((it, ii) => <li key={ii}>{inline(it, `${k}i${ii}`)}</li>)}
        </ul>,
      );
    } else if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && (/^\d+\.\s/.test(lines[i] ?? "") || /^\s{2,}\S/.test(lines[i] ?? ""))) {
        if (/^\d+\.\s/.test(lines[i] ?? "")) items.push((lines[i] ?? "").replace(/^\d+\.\s/, ""));
        else items[items.length - 1] += " " + (lines[i] ?? "").trim();
        i++;
      }
      blocks.push(
        <ol key={k} className="my-3 list-decimal space-y-1.5 pl-6 text-sm leading-relaxed">
          {items.map((it, ii) => <li key={ii}>{inline(it, `${k}o${ii}`)}</li>)}
        </ol>,
      );
    } else {
      // Paragraph: absorb following plain lines.
      const para: string[] = [line];
      i++;
      while (i < lines.length && (lines[i] ?? "").trim() && !/^(#{2,4} |[-*] |\d+\. |\||>|-{3,})/.test(lines[i] ?? "")) {
        para.push(lines[i] ?? "");
        i++;
      }
      blocks.push(<p key={k} className="my-3 text-sm leading-relaxed">{inline(para.join(" "), k)}</p>);
    }
  }

  return <div className="max-w-3xl">{blocks}</div>;
}
