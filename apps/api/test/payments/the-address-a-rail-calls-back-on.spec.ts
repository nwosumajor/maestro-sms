// =============================================================================
// Where a mobile-money rail is told to call back
// =============================================================================
// It was built from PUBLIC_API_URL, which is set NOWHERE — not in compose, not
// in .env.example, not in the ECS task definition. So the rails were handed
// `/payments/mobile-money/callback/mpesa`: a path with no host.
//
// And even set it would have been the wrong address. The API is not
// internet-facing in this architecture — the ALB forwards only /ws/* to it and
// REST flows web→api over Cloud Map — so a callback from Safaricom could never
// have arrived. The route that IS reachable already exists: the web tier's
// webhook proxy allowlists /api/webhooks/mobile-money/<provider> and forwards it
// to exactly this controller.
//
// WHAT IT COST, stated honestly: nothing is lost. These rails are unsigned and
// deliver once, which is why the hourly recovery sweep exists — it settles what
// no callback closed. But every mobile-money payment would have waited up to an
// hour for a sweep instead of settling when the payer finished, and the sweep
// would have been carrying the entire rail rather than catching its misses.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const service = readFileSync(join(__dirname, "../../src/payments/mobile-money.service.ts"), "utf8");
const proxy = readFileSync(join(__dirname, "../../../web/app/api/webhooks/[...path]/route.ts"), "utf8");
const terraform = readFileSync(join(__dirname, "../../../../infrastructure/terraform/ecs.tf"), "utf8");

describe("the callback address", () => {
  it("is built from a variable the deployment actually sets", () => {
    // PUBLIC_WEB_URL is in the task definition — the acceptance email depends on
    // it too. PUBLIC_API_URL is in no environment anywhere.
    expect(service).toMatch(/process\.env\.PUBLIC_WEB_URL/);
    expect(service).not.toMatch(/process\.env\.PUBLIC_API_URL/);
    expect(terraform).toMatch(/name = "PUBLIC_WEB_URL"/);
  });

  it("points at the tier a rail can reach, not the private one", () => {
    expect(service).toMatch(/\/api\/webhooks\/mobile-money\//);
  });

  it("matches a path the webhook proxy actually allows", () => {
    // A wrong target here is a 404 to a provider, and for these rails that means
    // the payer is debited and nothing settles until the sweep.
    expect(proxy).toMatch(/provider === "mobile-money"/);
    expect(proxy).toMatch(/\/payments\/mobile-money\/callback\/\$\{rest\[0\]\}/);
  });

  it("sends NOTHING rather than half a URL when the address is unknown", () => {
    // A rail that validates the address fails the charge loudly, which is better
    // than one that accepts nonsense and calls nobody — the failure that hid
    // here for as long as it did.
    expect(service).toMatch(/if \(!base\) \{[\s\S]{0,320}return "";/);
    expect(service).toMatch(/PUBLIC_WEB_URL is not set/);
  });

  it("never interpolates an empty base into a path", () => {
    // `${process.env.X ?? ""}/payments/...` is exactly how a hostless callback
    // gets sent to a payment provider and nobody notices.
    expect(service).not.toMatch(/\$\{process\.env\.\w+ \?\? ""\}\//);
  });
});
