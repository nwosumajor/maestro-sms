// =============================================================================
// Two packages, correctly labelled, linked to nothing
// =============================================================================
// Both Dockerfiles carried
//
//     LABEL org.opencontainers.image.source="https://github.com/…/maestro-sms"
//
// with a comment above it saying that is what GHCR reads. It is not. A LABEL
// becomes a config label on the CHILD image; buildx pushes an OCI image INDEX
// (the image plus its provenance attestation) and GHCR reads `source` from an
// ANNOTATION on that index, never descending into the child config. Measured on
// the pushed artifacts:
//
//     docker image inspect  -> org.opencontainers.image.source present
//     index annotations     -> null
//     gh api user/packages  -> repo=(not linked), both packages
//
// So the control was present, correct, visible to `docker inspect`, and did
// nothing — the shape this repo records as worse than a missing control, because
// the reader stops looking for the real switch.
//
// The fix is an `--annotation "index:…"` on the push. The `index:` prefix is the
// whole fix: without it the annotation lands on the child manifest and the
// package stays orphaned, with every command still reporting success. That is
// one token, invisible in review and untested by any push that has ever run —
// hence this gate.
// =============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATH_TO_SCRIPT = join(__dirname, "../../../../scripts/push-images.sh");
const SCRIPT = readFileSync(PATH_TO_SCRIPT, "utf8");

/**
 * DRIVE the script rather than read it: DRY_RUN prints the exact docker
 * invocation and touches no registry. Parsing the bash would have tied this
 * gate to today's spelling — the first draft did, and matched nothing once the
 * scopes moved into a `for scope in index manifest` loop.
 */
const DRY = execFileSync("bash", [PATH_TO_SCRIPT], {
  env: { ...process.env, DRY_RUN: "1" },
  encoding: "utf8",
  // The script warns on stderr when the tree is dirty — true, and not this
  // gate's business; it would print on every run during development.
  stdio: ["ignore", "pipe", "ignore"],
});

/** Every `--annotation <scope>:<key>` the script actually emits. */
function annotations(): Array<{ scope: string; key: string }> {
  return [...DRY.matchAll(/--annotation (?:\\?)([a-z]+):(org\.opencontainers\.image\.[a-z]+)=/g)].map(
    (m) => ({ scope: m[1], key: m[2] }),
  );
}

describe("the push annotates the index, not just the image", () => {
  it("sets image.source ON THE INDEX — the one GHCR actually reads", () => {
    // Anchored to the property: an annotation scoped `index`, carrying `source`.
    // A `manifest:`-only script would satisfy every other assertion here and
    // leave the packages exactly as orphaned as the LABEL did.
    const scopes = annotations()
      .filter((a) => a.key === "org.opencontainers.image.source")
      .map((a) => a.scope);
    expect(scopes).toContain("index");
  });

  it("annotates the manifest too, so a per-platform reader is not told less", () => {
    const scopes = annotations()
      .filter((a) => a.key === "org.opencontainers.image.source")
      .map((a) => a.scope);
    expect(scopes).toContain("manifest");
  });

  it("carries the revision, so a pushed image can be traced to a commit", () => {
    const keys = annotations().map((a) => a.key);
    expect(keys).toContain("org.opencontainers.image.revision");
  });

  it("VERIFIES the annotation landed rather than trusting a clean exit", () => {
    // A push can succeed and link nothing — that is the entire defect. The
    // script re-reads the pushed index and fails on a mismatch.
    const verify = SCRIPT.slice(SCRIPT.indexOf("imagetools inspect"));
    expect(verify).toMatch(/annotations/);
    expect(verify).toMatch(/exit "\$fail"/);
  });
});

describe("and it cannot reach production", () => {
  it("pushes to ghcr and refuses a production registry", () => {
    // Production runs from ECR (ecs.tf -> aws_ecr_repository, SHA-tagged by
    // deploy.yml, tag-immutable). This script must never be the thing that
    // moves a production image.
    expect(SCRIPT).toMatch(/readonly REGISTRY="ghcr\.io"/);
    expect(SCRIPT).toMatch(/\*ecr\*\|\*amazonaws\*\).*exit 1/);
  });
});

describe("the Dockerfiles no longer claim the label does the linking", () => {
  it.each(["api", "web"])("%s says what the label is actually for", (svc) => {
    const df = readFileSync(join(__dirname, `../../../../apps/${svc}/Dockerfile`), "utf8");
    // The label stays — it is what `docker inspect` reads and costs nothing.
    expect(df).toMatch(/LABEL org\.opencontainers\.image\.source=/);
    // But the sentence asserting it links the package is gone.
    expect(df).not.toMatch(/`source` label is what ghcr\.io reads/);
  });
});
