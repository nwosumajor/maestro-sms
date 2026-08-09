// =============================================================================
// Payment channels — which rails the platform is currently willing to CHARGE on
// =============================================================================
// A startup ships one rail first and adds others as it can afford to support
// them. This is the switchboard for that, owned by the platform operator.
//
// THE ONE RULE THAT MAKES IT SAFE: a channel being disabled stops the platform
// STARTING a new payment on it. It must NEVER stop the platform FINISHING one.
// Webhooks, verify-on-return, the reconciliation sweep and the mobile-money
// recovery sweep all deal with money that has ALREADY LEFT A PAYER'S ACCOUNT,
// and they must keep working on every channel for ever — including channels
// that were switched off years ago. Turning off a rail must never turn off the
// ledger, or a parent pays and the invoice stays open with nothing to fix it.
//
// So: enforce at INITIATION, never at settlement. `assertChannelEnabled` exists
// to be called from the handful of "start a payment" paths and nowhere else.
// =============================================================================

/** Every rail the platform can charge on. Adding one is a value here, a case in
 *  the operator screen, and a check at its own initiation path. */
export const PAYMENT_CHANNELS = {
  /** Cards + bank + USSD via Paystack. NGN/GHS/ZAR/KES/USD only. */
  PAYSTACK: "PAYSTACK",
  /** Cards via Stripe — the USD rail. */
  STRIPE: "STRIPE",
  /** M-Pesa / MTN MoMo / Airtel Money, picked by the school's region. */
  MOBILE_MONEY: "MOBILE_MONEY",
  /** Dedicated NUBAN virtual accounts (a pupil's own account number). */
  BANK_TRANSFER: "BANK_TRANSFER",
} as const;

export type PaymentChannel = (typeof PAYMENT_CHANNELS)[keyof typeof PAYMENT_CHANNELS];

export const PAYMENT_CHANNEL_VALUES = Object.values(PAYMENT_CHANNELS) as PaymentChannel[];

/** What a payer is told about a channel that is off. Never "error" — a rail the
 *  platform has not funded yet is a roadmap item, and saying so keeps a customer
 *  who would otherwise read a broken button as a broken product. */
export const CHANNEL_LABELS: Record<PaymentChannel, { name: string; comingSoon: string }> = {
  PAYSTACK: { name: "Card, bank transfer or USSD", comingSoon: "Card payments are coming soon." },
  STRIPE: { name: "International card (USD)", comingSoon: "International card payments are coming soon." },
  MOBILE_MONEY: { name: "Mobile money", comingSoon: "Mobile money is coming soon." },
  BANK_TRANSFER: { name: "Direct bank transfer", comingSoon: "Direct bank transfer is coming soon." },
};

/**
 * THE STARTUP DEFAULT: Paystack only.
 *
 * Deliberately the narrowest set that works, not the widest. A rail the team
 * cannot yet support costs more in failed payments and support load than the
 * revenue it adds, and every other rail's code stays in place and tested — so
 * switching one on later is a toggle, not a re-integration.
 */
export const DEFAULT_ENABLED_CHANNELS: PaymentChannel[] = [PAYMENT_CHANNELS.PAYSTACK];

export interface PaymentChannelConfig {
  enabled: PaymentChannel[];
}

export function isChannelEnabled(config: PaymentChannelConfig | null | undefined, channel: PaymentChannel): boolean {
  const enabled = config?.enabled?.length ? config.enabled : DEFAULT_ENABLED_CHANNELS;
  return enabled.includes(channel);
}

/** Narrow an arbitrary string list to real channels (config comes from a JSON
 *  column, so a stale value must not become a channel nobody can turn off). */
export function normaliseChannels(raw: unknown): PaymentChannel[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<PaymentChannel>();
  for (const v of raw) {
    if (typeof v === "string" && (PAYMENT_CHANNEL_VALUES as string[]).includes(v)) seen.add(v as PaymentChannel);
  }
  return [...seen];
}

// --- who can still be charged --------------------------------------------- //

/** Currencies each channel can actually settle. Paystack's list is the real
 *  constraint: five of the platform's twenty-nine currencies. */
export const CHANNEL_CURRENCIES: Record<PaymentChannel, readonly string[] | "ANY"> = {
  PAYSTACK: ["NGN", "GHS", "ZAR", "KES", "USD"],
  STRIPE: ["USD"],
  // Rail chosen by the school's region; the coverage table decides, not this.
  MOBILE_MONEY: "ANY",
  BANK_TRANSFER: ["NGN"],
};

/**
 * Can a school billed in `currency` be charged at all, given these channels?
 *
 * This is the question an operator needs answered BEFORE flipping a switch, not
 * after a parent fails to pay. Paystack alone covers Nigeria, Ghana, Kenya,
 * South Africa and anywhere billing in USD — and NOTHING else in the
 * catalogue, so turning the other rails off while a Senegalese or Ugandan
 * school is live leaves that school with no way to take money.
 */
export function currencyIsChargeable(currency: string, enabled: PaymentChannel[]): boolean {
  const code = (currency || "NGN").toUpperCase();
  return enabled.some((ch) => {
    const list = CHANNEL_CURRENCIES[ch];
    return list === "ANY" || list.includes(code);
  });
}
