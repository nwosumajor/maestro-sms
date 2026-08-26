// =============================================================================
// One invisible character, and the bill doubles
// =============================================================================
// GSM-7 holds 160 characters in one SMS (153 concatenated); a message with ONE
// character outside that alphabet is sent as UCS-2, which holds 70 (67
// concatenated). The school is debited ONE credit per MESSAGE and the platform
// pays the provider per SEGMENT — so a single character is the difference
// between charging once for one segment and charging once for two.
//
// Measured against this repo's own templates filled with realistic values:
// 13 extra segments across 28 templates, and EVERY fee notification at two.
// =============================================================================

import { formatMoney, isGsm7, smsCost, toSmsSafe } from "@sms/types";
import { TwilioChannelProvider } from "../../src/notifications/twilio-channel.provider";

const feeNotice = (currency: string, locale: string, student = "Adaeze Okonkwo") =>
  `Payment received\nWe received ${formatMoney(2_500_000, currency, locale)} for ${student}. ` +
  `Outstanding balance: ${formatMoney(7_500_000, currency, locale)}. Receipt PAY-2026-0042.`;

describe("a character that doubles the bill", () => {
  it("counts segments the way a provider bills them", () => {
    expect(smsCost("a".repeat(160))).toEqual({ encoding: "GSM-7", segments: 1 });
    expect(smsCost("a".repeat(161))).toEqual({ encoding: "GSM-7", segments: 2 });
    // One character outside the alphabet re-encodes the WHOLE message.
    expect(smsCost("a".repeat(70) + "₦")).toEqual({ encoding: "UCS-2", segments: 2 });
    // The extension table costs TWO septets each, so 80 euro signs are exactly
    // one full segment and 81 are two — an 81-character message that would fit
    // easily if the character were an ordinary one.
    expect(smsCost("€".repeat(80)).segments).toBe(1);
    expect(smsCost("€".repeat(81)).segments).toBe(2);
  });

  it("halves the commonest notification in the platform's home currency", () => {
    const notice = feeNotice("NGN", "en-NG");
    // Before: the naira sign alone pushes it to UCS-2 and over one segment.
    expect(smsCost(notice)).toEqual({ encoding: "UCS-2", segments: 2 });
    expect(smsCost(toSmsSafe(notice))).toEqual({ encoding: "GSM-7", segments: 1 });
  });

  it("removes the INVISIBLE ones, which is where this hides", () => {
    // "Ksh 25,000.00" and "R 25 000,00" carry a no-break space that is
    // indistinguishable from a space on any screen and re-encodes the message.
    for (const [currency, locale] of [["KES", "en-KE"], ["ZAR", "en-ZA"]] as const) {
      const notice = feeNotice(currency, locale);
      expect(isGsm7(notice)).toBe(false);
      expect(isGsm7(toSmsSafe(notice))).toBe(true);
    }
  });

  it("swaps a currency symbol for its own ISO code, never doubling the prefix", () => {
    // Ghana formats as "GH₵25,000.00"; a naive symbol swap gives "GHGHS ".
    expect(toSmsSafe(`Total ${formatMoney(2_500_000, "GHS", "en-GH")}`)).toBe("Total GHS 25,000.00");
    expect(toSmsSafe(`Total ${formatMoney(2_500_000, "NGN", "en-NG")}`)).toBe("Total NGN 25,000.00");
  });

  it("leaves a currency Intl already renders in GSM-7 exactly as it was", () => {
    for (const [currency, locale] of [["USD", "en-US"], ["GBP", "en-GB"]] as const) {
      const notice = feeNotice(currency, locale);
      expect(toSmsSafe(notice)).toBe(notice);
    }
  });

  it("NEVER mangles a name to save money", () => {
    // A pupil called Ṣadé is sent as Ṣadé, in UCS-2, at whatever it costs.
    // Folding a child's name into a cheaper alphabet is the wrong trade, and it
    // is different in kind from swapping ₦ for the code ₦ stands for.
    const notice = feeNotice("NGN", "en-NG", "Ṣadé Adéọlá Ọbi");
    const safe = toSmsSafe(notice);
    expect(safe).toContain("Ṣadé Adéọlá Ọbi");
    // And since it is UCS-2 regardless, the symbol is left as the nicer form.
    expect(safe).toContain("₦");
    expect(smsCost(safe).encoding).toBe("UCS-2");
  });

  it("is an SMS rule, not a Twilio rule — WhatsApp is left alone", async () => {
    // WhatsApp rides the same Messages API and is billed per CONVERSATION, not
    // per segment, and renders Unicode natively. Folding ₦ to NGN there
    // degrades what a family reads and saves nothing.
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM = "+15550000000";
    const sent: string[] = [];
    const original = global.fetch;
    global.fetch = (async (_u: string, init: { body?: unknown }) => {
      sent.push(new URLSearchParams(String(init.body)).get("Body") ?? "");
      return { ok: true, status: 201, json: async () => ({ sid: "SM1", num_segments: "1" }) };
    }) as unknown as typeof fetch;
    try {
      const provider = new TwilioChannelProvider();
      const body = `We received ${formatMoney(2_500_000, "NGN", "en-NG")} for Adaeze.`;
      const whatsapp = await provider.deliver({
        channel: "WHATSAPP", target: "+2348000000000", title: "Payment received", body,
      });
      await provider.deliver({
        channel: "SMS", target: "+2348000000000", title: "Payment received", body,
      });
      expect(sent[0]).toContain("₦25,000.00");
      expect(sent[1]).toContain("NGN 25,000.00");
      // And no segment count is invented for a channel that has none.
      expect(whatsapp.segments).toBeUndefined();
    } finally {
      global.fetch = original;
    }
  });

  it("normalises typographic punctuation, which no reader will notice", () => {
    expect(toSmsSafe("Term 1 – 2 … done")).toBe("Term 1 - 2 ... done");
  });
});
