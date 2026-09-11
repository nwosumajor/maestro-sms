// =============================================================================
// Removing comments from a source file, correctly — the WEB tier's copy
// =============================================================================
// The API tier has this function and a gate forcing every gate to use it
// (`apps/api/test/support/strip-comments.ts`). The web tier had NEITHER: five
// gates here each hand-rolled the same two-line regex
//
//     src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
//
// which the API-side file records as measurably wrong. Its block pattern does
// not know a `/*` can appear where it opens nothing — inside a line comment, or
// inside a string. Write a path glob in a comment and its `/*` pairs with the
// NEXT `*/` in the file, taking every line between them with it. Measured on
// the API tree: 14 files lost real code that way, up to 44 lines at once.
//
// The dangerous direction is silent. A `not.toMatch` over a region that was
// swallowed passes VACUOUSLY — the gate reports the property holds because it
// can no longer see the code that would violate it.
//
// Sibling asymmetry, exactly as CLAUDE.md describes it: the careful half was
// written on one side of the monorepo and the other was left. This is that
// function, so the web's gates stop keeping six copies of a broken one.
// =============================================================================

export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];

    // Double quotes and backticks are copied through whole, because that is
    // where URLs live: `"http://localhost:3001"` contains a `//`, and stripping
    // from there to the end of the line would hide real code from a gate.
    //
    // Single quotes are deliberately NOT tracked: in .tsx the apostrophe in JSX
    // text (`<p>the school's bill</p>`) is not a string opener, and treating it
    // as one swallows everything to the next apostrophe.
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

    // A LINE comment is consumed WHOLESALE, and that is what makes a `/*`
    // written inside one harmless — the scanner is never positioned inside a
    // line comment when it tests for a block opener.
    //
    // The order of these two checks is therefore defensive rather than
    // load-bearing: swapping them produces byte-identical output on the very
    // input the ordering is supposed to protect (verified, both orders keep the
    // code after `// the /cbt/* routes are module-gated`). Said plainly here
    // because a comment claiming an ordering is "the fix" invites a later
    // reader to preserve the wrong thing — it is the CHARACTER SCANNER that
    // fixes this, not the sequence of two ifs.
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
