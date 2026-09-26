// =============================================================================
// The go-live rehearsal must not report TLS it did not check
// =============================================================================
// infrastructure/scripts/go-live-rehearsal.sh has three outcomes, and the whole
// point of it is that a PASS means "verified, here and now". Its homepage check
// was named "homepage answers over TLS" and only asked for an HTTP 200 — so
// given a plain http:// address (found by running it against http://localhost)
// it PASSED "over TLS" having checked no TLS at all. With an https:// address
// curl validates the certificate by default, so a 200 there does prove it.
//
// DRIVES THE REAL SCRIPT, the way `a-label-that-linked-nothing` drives
// push-images.sh: against a plain http:// address on a closed local port, so
// every network check fails fast and nothing leaves the machine.
// =============================================================================
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(__dirname, "../../../../infrastructure/scripts/go-live-rehearsal.sh");

function rehearse(url: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, REHEARSAL_URL: url, I_KNOW_THIS_IS_A_THROWAWAY_ACCOUNT: "yes" };
  for (const k of ["DOCS_BUCKET", "DB_URL", "RDS_INSTANCE_ID", "AWS_PROFILE"]) delete env[k];
  const r = spawnSync("bash", [script, "--phase", "app"], { env, encoding: "utf8", timeout: 60_000 });
  // Colour codes stripped, so the assertions read the words.
  return `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("go-live rehearsal: the TLS line", () => {
  const out = rehearse("http://127.0.0.1:9");

  it("ran the application phase at all (a run that checked nothing must not pass this)", () => {
    expect(out).toMatch(/API is genuinely up/);
  });

  it("SKIPS the TLS check for an http:// address instead of passing it", () => {
    expect(out).toMatch(/SKIP\s+homepage answers over TLS — REHEARSAL_URL is not https:\/\//);
    expect(out).not.toMatch(/PASS\s+homepage answers over TLS/);
  });
});
