// =============================================================================
// The manual's HTML → the same block model the markdown produces
// =============================================================================
// The two runbooks are markdown and get a PDF from a markdown parser. The
// School Leader's Manual is hand-authored HTML, which is why it was the one
// document still relying on the browser's print export.
//
// This gives it the same treatment: a parser that produces the SAME blocks, fed
// to the SAME pdf emitter. What that buys is not tidiness — it is that all three
// documents render through one piece of layout code, so a fix to how a table
// breaks across a page fixes it everywhere, and a PDF cannot quietly diverge
// from its own page.
//
// It is a tag-stream parser, not a general HTML parser, and that is a deliberate
// limit: it handles exactly what this document contains, verified by counting
// the constructs in it rather than by trusting a specification. Anything else
// would be a dependency and a much larger surface for one file we control.
// =============================================================================

import { slug } from "./markdown-blocks.mjs";

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", rarr: "→", larr: "←", times: "×",
  eacute: "é", pound: "£", euro: "€", deg: "°", middot: "·",
};

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);
}

/** Collapse the whitespace HTML authors use for indentation. */
const tidy = (s) => decodeEntities(s.replace(/\s+/g, " ")).trim();

/**
 * Inline HTML → the run model the PDF emitter styles.
 *
 * `<strong>`, `<em>`, `<code>` and `<a href>` carry meaning; `<span>` and
 * `<br>` do not survive into a block model and are flattened. Anything else is
 * dropped to its text, which is the right default for a document that will grow
 * new decorative wrappers over time.
 */
export function htmlRuns(html) {
  const runs = [];
  const stack = [];
  const push = (text) => {
    const t = decodeEntities(text.replace(/\s+/g, " "));
    if (!t) return;
    runs.push({
      text: t,
      bold: stack.includes("strong") || stack.includes("b") || undefined,
      italic: stack.includes("em") || stack.includes("i") || undefined,
      code: stack.includes("code") || undefined,
      href: stack.find((s) => s.startsWith("href:"))?.slice(5),
    });
  };
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m.index > last) push(html.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[1].toLowerCase();
    const closing = m[0].startsWith("</");
    if (tag === "br") {
      runs.push({ text: " " });
      continue;
    }
    if (closing) {
      if (tag === "a") {
        const i = stack.findIndex((s) => s.startsWith("href:"));
        if (i >= 0) stack.splice(i, 1);
      } else {
        const i = stack.lastIndexOf(tag);
        if (i >= 0) stack.splice(i, 1);
      }
    } else if (tag === "a") {
      const href = /href\s*=\s*"([^"]*)"/.exec(m[2])?.[1] ?? "";
      // In-page anchors mean nothing in a printed document.
      if (href && !href.startsWith("#")) stack.push(`href:${href}`);
      else stack.push("a");
    } else if (["strong", "b", "em", "i", "code"].includes(tag)) {
      stack.push(tag);
    }
  }
  if (last < html.length) push(html.slice(last));
  return runs.filter((r) => r.text.trim() !== "" || r.text === " ");
}

/** Runs → the markdown-ish inline string the shared emitters accept. */
function runsToInline(runs) {
  return runs
    .map((r) => {
      if (r.code) return `\`${r.text}\``;
      if (r.href) return `[${r.text}](${r.href})`;
      if (r.bold) return `**${r.text}**`;
      return r.text;
    })
    .join("");
}

/**
 * The manual's HTML → blocks.
 *
 * Only `<main>` is read. The masthead, the contents rail, the print bar and the
 * script are chrome for the screen: a printed document has its own cover and a
 * table of contents that would be wrong the moment the pagination changed.
 *
 * `<details>` is EXPANDED rather than skipped — it collapses on screen to keep a
 * long page navigable, and a reader holding the PDF has no way to open it. The
 * screen stylesheet already does the same thing when printing.
 */
export function parseManualHtml(html) {
  const mainStart = html.indexOf("<main>");
  const mainEnd = html.lastIndexOf("</main>");
  const body = mainStart === -1 ? html : html.slice(mainStart + 6, mainEnd);
  const blocks = [];
  const toc = [];
  scan(body, blocks, toc);
  return { blocks, toc };
}

/** Block-level tags that mean a list item is really a small section. */
const BLOCK_INSIDE_LI = /<(h3|h4|p)\b/i;

function scan(body, blocks, toc) {
  const re = /<(h2|h3|h4|p|ul|ol|table|summary|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(body))) {
    const tag = m[1].toLowerCase();
    const inner = m[2];

    if (tag === "h2" || tag === "h3" || tag === "h4") {
      const text = tidy(inner.replace(/<[^>]*>/g, ""));
      if (!text) continue;
      const level = tag === "h2" ? 2 : tag === "h3" ? 3 : 4;
      const id = slug(text);
      if (level === 2) toc.push({ id, text });
      blocks.push({ type: "heading", level, text, id });
      continue;
    }

    if (tag === "summary") {
      // The question a collapsed section answers reads as a sub-heading once it
      // can no longer be collapsed.
      const text = tidy(inner.replace(/<[^>]*>/g, ""));
      if (text) blocks.push({ type: "heading", level: 4, text, id: slug(text) });
      continue;
    }

    if (tag === "p") {
      const text = runsToInline(htmlRuns(inner)).trim();
      if (text) blocks.push({ type: "para", text });
      continue;
    }

    if (tag === "blockquote") {
      const text = runsToInline(htmlRuns(inner)).trim();
      if (text) blocks.push({ type: "quote", text });
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      const rawItems = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((li) => li[1]);

      // A LIST WHOSE ITEMS ARE SECTIONS IS NOT A LIST.
      //
      // The 30-day plan is `<li><h4>Create your staff accounts</h4>
      // <span class="where">Admin -> Users</span><p>...</p></li>`. Flattened to
      // one line per item it came out as
      // "Create your staff accountsAdmin -> Users, then Admin -> RolesAdd
      // teachers, your accountant..." — every word present and none of it
      // readable, which is the same failure as a table whose cells overlap.
      // Those items are expanded into the blocks they actually are, in order.
      if (rawItems.some((li) => BLOCK_INSIDE_LI.test(li))) {
        for (const li of rawItems) {
          // The "where to go" pointer is a span, not a block, so it would be
          // lost by the block scanner. It is the most useful line in the step.
          const where = /<span[^>]*class="where"[^>]*>([\s\S]*?)<\/span>/i.exec(li);
          scan(li, blocks, toc);
          if (where) {
            const text = tidy(where[1].replace(/<[^>]*>/g, ""));
            // Placed after the heading the scanner just emitted, before its
            // paragraphs would read oddly — so it is appended as its own line
            // and marked, which is how it reads on screen.
            if (text) {
              const headingAt = blocks.map((b) => b.type).lastIndexOf("heading");
              const insertAt = headingAt >= 0 ? headingAt + 1 : blocks.length;
              blocks.splice(insertAt, 0, { type: "para", text: `**Where:** ${text}` });
            }
          }
        }
        continue;
      }

      const items = rawItems.map((li) => runsToInline(htmlRuns(li)).trim()).filter(Boolean);
      if (items.length) blocks.push({ type: "list", ordered: tag === "ol", items });
      continue;
    }

    if (tag === "table") {
      const headCells = [...inner.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((c) =>
        tidy(c[1].replace(/<[^>]*>/g, "")),
      );
      const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map((tr) =>
          [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
            tidy(c[1].replace(/<[^>]*>/g, "")),
          ),
        )
        .filter((r) => r.length > 0);
      if (rows.length || headCells.length) {
        blocks.push({ type: "table", head: headCells.length ? headCells : null, rows });
      }
      continue;
    }
  }
}
