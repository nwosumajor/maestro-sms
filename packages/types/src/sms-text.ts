// =============================================================================
// An SMS is billed by the SEGMENT, and one invisible character halves a segment
// =============================================================================
// GSM-7 packs 160 characters into a single SMS (153 each once concatenated). A
// message containing ONE character outside that alphabet is sent as UCS-2, which
// holds 70 (67 concatenated) — so a single character can double or treble what a
// message costs to send.
//
// The platform debits the school ONE message credit per message and pays Twilio
// per SEGMENT. Measured against this repo's own templates and its own
// `formatMoney`, filled with realistic values: **13 extra segments across 28
// templates**, and every fee notification — the commonest kind, and the ones
// about money — came out at two.
//
// The cause, per currency, and it is not the obvious one:
//
//   NGN  "₦25,000.00"        ₦ U+20A6      <- the platform's HOME currency
//   GHS  "GH₵25,000.00"      ₵ U+20B5
//   KES  "Ksh 25,000.00"     U+00A0        <- an INVISIBLE no-break space
//   ZAR  "R 25 000,00"       U+00A0
//   XOF  "2 500 000 F CFA"   U+202F, U+00A0
//   USD  "$25,000.00"        (fine)
//   GBP  "£25,000.00"        (fine)
//
// Five of seven, and the two that are fine are the two this platform is least
// sold in. The KES/ZAR/XOF cases are the sharpest: the character is a SPACE that
// looks exactly like a space, is indistinguishable on any screen, and doubles
// the bill.
//
// `formatMoneyPdf` already exists for precisely this problem in a different
// output — a target that cannot carry the symbol, so it prints the ISO code
// instead. SMS is a third target with the same constraint and had nothing. The
// sibling asymmetry this repo keeps finding.
//
// WHAT THIS DOES NOT DO: mangle a name to save money. A pupil called `Ṣadé` is
// sent as `Ṣadé`, in UCS-2, at whatever it costs — folding a child's name into
// a cheaper alphabet is the wrong trade, and different from swapping a symbol
// for its own ISO code or a no-break space for a space.
// =============================================================================

/** GSM 03.38 basic alphabet — one septet each. */
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

/** The extension table — two septets each, so they cost double. */
const GSM_EXTENDED = "^{}\\[~]|€";

export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM_BASIC.includes(ch) && !GSM_EXTENDED.includes(ch)) return false;
  }
  return true;
}

export interface SmsCost {
  encoding: "GSM-7" | "UCS-2";
  /** Billable segments — what the provider charges for. */
  segments: number;
}

/** What a body will actually cost to send. */
export function smsCost(text: string): SmsCost {
  if (isGsm7(text)) {
    let septets = 0;
    for (const ch of text) septets += GSM_EXTENDED.includes(ch) ? 2 : 1;
    return { encoding: "GSM-7", segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  }
  // UCS-2 counts UTF-16 code units, so anything outside the BMP costs two.
  let units = 0;
  for (const ch of text) units += ch.codePointAt(0)! > 0xffff ? 2 : 1;
  return { encoding: "UCS-2", segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

/** Space-like separators `Intl` emits that GSM-7 has no room for. */
const SPACES = /[    ⁠]/g;

/** Typographic characters with an exact plain equivalent. */
const PLAIN: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  "…": "...",
};

/**
 * Currency symbols outside GSM-7, mapped to the ISO code the symbol stands for
 * — the same substitution `formatMoneyPdf` makes with `currencyDisplay: "code"`.
 *
 * A DATA table, not a branch: a new currency is a row.
 */
const SYMBOL_TO_CODE: Record<string, string> = {
  "₦": "NGN ",
  "₵": "GHS ",
  "₹": "INR ",
  "₽": "RUB ",
  "₩": "KRW ",
  "₪": "ILS ",
  "₫": "VND ",
  "₱": "PHP ",
  "₨": "PKR ",
  "₴": "UAH ",
  "₮": "MNT ",
  "₭": "LAK ",
  "₾": "GEL ",
  "₸": "KZT ",
};

/**
 * Make a message as cheap to send as it can be WITHOUT changing what it says.
 *
 * Two passes, and the order matters:
 *
 *  1. Always normalise invisible separators and typographic punctuation. These
 *     substitutions are imperceptible to the reader, so there is no reason to
 *     pay for them.
 *  2. Only if the message is STILL not GSM-7, swap a currency symbol for its
 *     ISO code — a visible change, so it is made only when it actually buys
 *     something. A message already carrying a name outside the alphabet is sent
 *     in UCS-2 either way, and `₦` is nicer to read than `NGN `.
 */
export function toSmsSafe(text: string): string {
  const normalised = text
    .replace(SPACES, " ")
    .replace(/[‘’“”–—−…]/g, (ch) => PLAIN[ch] ?? ch);
  if (isGsm7(normalised)) return normalised;
  const coded = normalised.replace(
    /[₦₵₹₽₩₪₫₱₨₴₮₭₾₸]/g,
    (ch) => SYMBOL_TO_CODE[ch] ?? ch,
  );
  // `GH₵` becomes `GHGHS `, and a doubled prefix reads as a typo.
  return isGsm7(coded) ? coded.replace(/\b([A-Z]{2})([A-Z]{3}) /g, "$2 ") : normalised;
}
