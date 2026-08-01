// =============================================================================
// Module graph — the class of bug unit tests cannot see
// =============================================================================
// The mobile-money rail was first written into PaymentsModule, which imported
// SettlementModule, which imports NotificationModule, which imports
// PaymentsModule. A cycle. Nest refuses to boot on it.
//
// Every unit test still passed — 1,402 of them — because a unit test constructs a
// service directly and never builds the module graph. The web build passed. The
// typecheck passed. It was only caught by starting the container, and even then
// `/api/health` answered 200, because that is the WEB tier's probe and does not
// touch the API at all (the gotcha the incident runbook documents).
//
// So: a test that reads the module wiring and asserts the ONE property that was
// violated. Cheap, no DB, no Nest bootstrap — and it fails in seconds rather than
// at deploy.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/** Module names in an `imports: [...]` array. */
function importsOf(file: string): string[] {
  const m = /imports:\s*\[([\s\S]*?)\]/.exec(read(file));
  if (!m) return [];
  return [...m[1].matchAll(/\b([A-Z]\w*Module)\b/g)].map((x) => x[1]);
}

describe("PaymentsModule stays a LEAF", () => {
  it("imports no module at all", () => {
    // NotificationModule imports PaymentsModule for message credits. Anything
    // PaymentsModule imports that reaches NotificationModule closes a cycle and the
    // app will not start — which is exactly what happened, and what this pins.
    expect(importsOf("payments/payments.module.ts")).toEqual([]);
  });

  it("does not host the mobile-money rail, which needs SettlementModule", () => {
    // Checked against the PROVIDERS array, not the raw file — the file names
    // SettlementModule in a comment explaining why it must not import it, and an
    // assertion that cannot tell a comment from code is not an assertion.
    const providers = /providers:\s*\[([\s\S]*?)\]/.exec(read("payments/payments.module.ts"))?.[1] ?? "";
    expect(providers).not.toContain("MobileMoneyService");
    expect(importsOf("payments/payments.module.ts")).not.toContain("SettlementModule");
  });
});

describe("MobileMoneyModule is wired like DisputesModule", () => {
  it("imports the two it needs and is imported by Fees", () => {
    // The established shape for a feature that spans gateways and settlement:
    // its own module, importing both, imported by FeesModule, imported BY neither.
    //
    // Asserted as a SUBSET plus an explicit deny-list, not as an exact array: it
    // also registers a BullMQ queue for the recovery sweep, and infrastructure
    // modules like BullModule carry no cycle risk. An exact-match assertion here
    // fails on every such addition, which trains people to loosen it — the one
    // outcome that would let a real cycle back in.
    const imports = importsOf("payments/mobile-money.module.ts");
    expect(imports).toEqual(expect.arrayContaining(["PaymentsModule", "SettlementModule"]));
    expect(importsOf("fees/fees.module.ts")).toContain("MobileMoneyModule");
  });

  it("imports no FEATURE module beyond those two", () => {
    // The deny-list half. Anything reaching NotificationModule closes the cycle
    // that stopped Nest booting; FeesModule imports THIS, so importing it back is
    // the other direction of the same mistake.
    const imports = importsOf("payments/mobile-money.module.ts");
    for (const forbidden of ["NotificationModule", "FeesModule", "BillingModule", "MobileMoneyModule"]) {
      expect({ forbidden, present: imports.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("does not import NotificationModule directly — settlement owns the receipts", () => {
    // Two paths sending receipts is how a payer gets told twice.
    expect(importsOf("payments/mobile-money.module.ts")).not.toContain("NotificationModule");
  });
});

describe("no module imports itself, directly or through one hop", () => {
  it("holds across the payment and settlement modules", () => {
    // A cheap two-hop check over the modules this feature touches. It would have
    // caught the original cycle: Payments -> Settlement -> Notification -> Payments.
    const files: Record<string, string> = {
      PaymentsModule: "payments/payments.module.ts",
      MobileMoneyModule: "payments/mobile-money.module.ts",
      SettlementModule: "fees/settlement.module.ts",
      NotificationModule: "notifications/notification.module.ts",
      DisputesModule: "fees/disputes.module.ts",
    };
    const graph = new Map<string, string[]>(
      Object.entries(files).map(([name, path]) => [name, importsOf(path)]),
    );
    for (const [name, direct] of graph) {
      expect({ name, selfImport: direct.includes(name) }).toEqual({ name, selfImport: false });
      for (const hop of direct) {
        const second = graph.get(hop) ?? [];
        expect({ cycle: `${name} -> ${hop} -> ${name}`, present: second.includes(name) }).toEqual({
          cycle: `${name} -> ${hop} -> ${name}`,
          present: false,
        });
      }
    }
  });
});
