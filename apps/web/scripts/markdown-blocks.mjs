// =============================================================================
// One parser, many emitters
// =============================================================================
// The runbooks are rendered twice: as an HTML page to read in the product, and
// as a PDF to keep, print or hand to somebody. Both come from the same markdown,
// and — the part that matters — from the same PARSE of it.
//
// The alternative, two renderers each reading the markdown their own way, is the
// duplicated-artefact failure this codebase keeps meeting: two things claiming to
// be the same document, and the one nobody checks is the one somebody trusts.
// Here there is a single block list and two dumb emitters over it. A construct
// the parser does not know about is missing from BOTH outputs, visibly, rather
// than from one of them quietly.
//
// The subset is what these documents actually use, verified against them rather
// than written to a specification: headings, paragraphs, fenced code, inline
// code, bold, links, bullet and ordered lists, tables, blockquotes and rules.
// =============================================================================

/**
 * @typedef {{type:"heading",level:number,text:string,id:string}
 *   | {type:"para",text:string}
 *   | {type:"code",text:string}
 *   | {type:"list",ordered:boolean,items:string[]}
 *   | {type:"table",head:string[]|null,rows:string[][]}
 *   | {type:"quote",text:string}
 *   | {type:"rule"}} Block
 */

export const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * Markdown → blocks.
 *
 * FENCES WIN OVER EVERYTHING. Both runbooks are largely shell, and a
 * `# comment` inside a bash block is a comment, not a heading. A parser that
 * missed this would turn commands into section titles in both outputs at once.
 *
 * Inline text is left as MARKDOWN in the block (`**bold**`, backticks, links);
 * each emitter decides what to do with it, because escaping for HTML and
 * styling runs in a PDF are different problems with different rules.
 *
 * @returns {{blocks: Block[], toc: {id:string,text:string}[]}}
 */
export function parseMarkdown(md) {
  const lines = md.split("\n");
  /** @type {Block[]} */
  const blocks = [];
  const toc = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        rows.push(lines[i]);
        i += 1;
      }
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const isDivider = (r) => /^\|[\s:|-]+\|?$/.test(r);
      const hasHead = rows[1] && isDivider(rows[1]);
      blocks.push({
        type: "table",
        head: hasHead ? cells(rows[0]) : null,
        rows: rows.filter((r, n) => !isDivider(r) && (hasHead ? n > 0 : true)).map(cells),
      });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const id = slug(text.replace(/[`*]/g, ""));
      if (level === 2) toc.push({ id, text: text.replace(/[`*]/g, "") });
      blocks.push({ type: "heading", level, text, id });
      i += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (
        i < lines.length &&
        (ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*[-*]\s+/.test(lines[i]))
      ) {
        items.push(lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (/^-{3,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    if (line.startsWith(">")) {
      const body = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: body.join(" ") });
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("|") &&
      !lines[i].startsWith(">") &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^-{3,}\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "para", text: para.join(" ") });
  }

  return { blocks, toc };
}

/**
 * Inline markdown → runs, for an emitter that styles rather than tags.
 *
 * Code spans are taken first so a `**` or a bracket INSIDE backticks is never
 * read as formatting — these documents are full of commands meant to be copied
 * exactly, and a mangled one is worse than an unstyled one.
 *
 * @returns {{text:string, bold?:boolean, code?:boolean, href?:string}[]}
 */
export function inlineRuns(src) {
  const runs = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(src))) {
    if (m.index > last) runs.push({ text: src.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("`")) runs.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith("**")) runs.push({ text: tok.slice(2, -2), bold: true });
    else {
      const link = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      runs.push({ text: link[1], href: link[2] });
    }
    last = m.index + tok.length;
  }
  if (last < src.length) runs.push({ text: src.slice(last) });
  return runs.filter((r) => r.text !== "");
}
