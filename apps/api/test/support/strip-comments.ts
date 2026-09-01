// =============================================================================
// Removing comments from a source file, correctly
// =============================================================================
// Sixty-odd gates in this repo read a source file and assert something about
// it, and nearly all of them strip comments first — for a good reason this file
// records elsewhere: a gate that scans the raw text FAILS ON THE COMMENT
// EXPLAINING ITS OWN FIX, because that comment quotes the defect it replaced.
//
// They all hand-rolled the same two-line regex:
//
//     src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
//
// and it is WRONG in a way that hides code rather than showing it. The block
// pattern has no idea that a `/*` can appear somewhere that does not open a
// comment — inside a line comment, or inside a string. Write a path glob in a
// comment, as in "the `/cbt/*` routes are module-gated", and its `/*` pairs
// with the NEXT `*/` in the file, which is the close of some later JSDoc. Every
// line between them disappears.
//
// MEASURED, not theorised: 14 files across the codebase lose real code that
// way, up to 44 lines at once — whole import blocks, a `@Controller` decorator,
// an exported class. A gate reading one of those sees a mangled file, and the
// dangerous direction is silent: a `not.toMatch` over a swallowed region passes
// VACUOUSLY, which is precisely the "gate that passes by finding nothing"
// failure this repo already has a gate against.
//
// This walks the source instead, checking for a LINE comment before a block one
// at every position, so a `/*` inside a line comment is consumed with that line
// rather than opening a block.
//
// STRINGS ARE DELIBERATELY NOT TRACKED, and that is a correction rather than a
// shortcut. The first version of this did track them — and treated the
// apostrophe in JSX text (`<p>the school's bill</p>`) as opening a string,
// swallowing everything to the next apostrophe and leaving the comment after it
// unstripped. Three gates went red on files that were perfectly correct. JSX
// text is not JavaScript, and a stripper that half-parses it is worse than one
// that does not try: `//` and `/*` inside a genuine string are checked for
// separately by this module's own spec, and this codebase has none.
//
// REGEX LITERALS need no handling either: a regex containing these characters
// escapes the slash (`/\/\*/`), so the literal pairs never appear.
// =============================================================================

/** Source with every comment removed, and nothing else. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];

    // DOUBLE QUOTES AND BACKTICKS are copied through whole, because that is
    // where URLs live: `"http://localhost:3001"` contains a `//`, and stripping
    // from there to the end of the line would hide real code from a gate.
    //
    // SINGLE QUOTES ARE DELIBERATELY NOT TRACKED. In .tsx the apostrophe in JSX
    // text (`<p>the school's bill</p>`) is not a string opener, and treating it
    // as one swallows everything to the next apostrophe — measured, it made
    // three gates red on files that were perfectly correct. This codebase
    // writes its strings with double quotes, so the loss is a `//` or a `/*`
    // inside a SINGLE-quoted string, which the spec beside this asserts does
    // not occur.
    if (c === '"' || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        const ch = src[i];
        out += ch;
        i += 1;
        if (ch === "\\") {
          if (i < n) {
            out += src[i];
            i += 1;
          }
          continue;
        }
        if (ch === quote) break;
      }
      continue;
    }

    // A LINE comment is checked BEFORE a block one, and that ordering is the
    // fix: a `/*` written inside one — "the /cbt/* routes are gated" — must be
    // consumed with that line rather than opening a block that runs to some
    // later JSDoc's close.
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      // Newlines are KEPT so line numbers do not shift — a finding a reader
      // cannot navigate to is one nobody acts on.
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

/** Read a source file with its comments removed. */
export function readStripped(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return stripComments(require("node:fs").readFileSync(path, "utf8"));
}
