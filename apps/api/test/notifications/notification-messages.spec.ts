// =============================================================================
// Notification messages — the francophone slice
// =============================================================================
// Twelve countries in the catalogue are francophone. The platform speaks English,
// and translating all ~2,138 UI strings would be the wrong order of work: a
// parent in Dakar rarely opens the web app, but they always get the SMS. So the
// messages that LEAVE the building are localised first.
//
// The rules these defend:
//   • every entry carries EVERY language — a half-translated catalogue produces
//     a French inbox with English holes, which reads as broken rather than
//     untranslated
//   • an unknown key falls back to the producer's English, never to the key
//     itself: "attendance.absnet" must never reach a parent
//   • migrating a producer changes the LANGUAGE and nothing else

import {
  DEFAULT_MESSAGE_LANGUAGE,
  MESSAGE_LANGUAGES,
  NOTIFICATION_MESSAGES,
  messageLanguage,
  renderNotification,
} from "@sms/types";

describe("messageLanguage", () => {
  it("narrows a locale to a language we have text for", () => {
    expect(messageLanguage("fr-SN")).toBe("fr");
    expect(messageLanguage("fr-CI")).toBe("fr");
    expect(messageLanguage("en-NG")).toBe("en");
  });

  it("falls back to English for a language with no catalogue", () => {
    // Egypt is ar-EG. Arabic needs an embedded font and RTL shaping, which is a
    // different job — until then an Egyptian school gets correct English rather
    // than mangled Arabic.
    expect(messageLanguage("ar-EG")).toBe("en");
    expect(messageLanguage(null)).toBe(DEFAULT_MESSAGE_LANGUAGE);
    expect(messageLanguage(undefined)).toBe(DEFAULT_MESSAGE_LANGUAGE);
    expect(messageLanguage("")).toBe(DEFAULT_MESSAGE_LANGUAGE);
  });

  it("is case-insensitive about the locale it is handed", () => {
    expect(messageLanguage("FR-CI")).toBe("fr");
  });
});

describe("the catalogue is complete", () => {
  it("has every language for every entry — no silent English holes", () => {
    for (const [key, tpl] of Object.entries(NOTIFICATION_MESSAGES)) {
      for (const lang of MESSAGE_LANGUAGES) {
        expect(`${key}.title.${lang}=${tpl.title[lang] ?? ""}`).not.toMatch(/=$/);
        expect(`${key}.body.${lang}=${tpl.body[lang] ?? ""}`).not.toMatch(/=$/);
      }
    }
  });

  it("does not ship a French string identical to its English one", () => {
    // The commonest way a catalogue rots: an entry added in English and copied
    // into the French slot to satisfy the completeness check.
    const copied = Object.entries(NOTIFICATION_MESSAGES).filter(
      ([, t]) => t.body.fr === t.body.en && t.body.en.length > 12,
    );
    expect(copied.map(([k]) => k)).toEqual([]);
  });

  it("uses the same placeholders in every language", () => {
    // A placeholder present in one language and missing in another means one
    // set of readers loses the date or the amount.
    const holes = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(",");
    for (const [key, tpl] of Object.entries(NOTIFICATION_MESSAGES)) {
      expect(`${key}:${holes(tpl.body.fr)}`).toBe(`${key}:${holes(tpl.body.en)}`);
    }
  });
});

describe("renderNotification", () => {
  it("writes the French text for a French reader", () => {
    const r = renderNotification("attendance.absent", "fr", { date: "2027-02-10" });
    expect(r?.body).toContain("Votre enfant");
    expect(r?.body).toContain("2027-02-10");
    expect(r?.title).toBe("Alerte de présence");
  });

  it("writes the English text for an English reader", () => {
    const r = renderNotification("attendance.absent", "en", { date: "2027-02-10" });
    expect(r?.body).toBe("Your child was marked ABSENT on 2027-02-10.");
  });

  it("returns null for an unknown key rather than emitting the key", () => {
    // The caller falls back to its literal English. Sending a parent
    // "attendance.absnet" would be worse than sending correct English.
    expect(renderNotification("attendance.absnet", "fr")).toBeNull();
  });

  it("leaves an unsupplied placeholder visible instead of printing undefined", () => {
    // A visible {date} is a bug report; "undefined" is noise a parent cannot act on.
    expect(renderNotification("attendance.absent", "en")?.body).toContain("{date}");
    expect(renderNotification("attendance.absent", "en")?.body).not.toContain("undefined");
  });

  it("substitutes every occurrence and every named parameter", () => {
    const r = renderNotification("fees.payment_received", "fr", {
      amount: "50 000 FCFA",
      student: "Amadou",
      balance: "0 FCFA",
      reference: "REC-1",
    });
    expect(r?.body).toBe("Nous avons reçu 50 000 FCFA pour Amadou. Solde restant : 0 FCFA. Reçu REC-1.");
  });

  it("does not let a parameter value containing braces re-trigger substitution", () => {
    // A student legitimately named with braces is absurd, but a value that gets
    // re-scanned is how a substitution loop becomes an injection.
    const r = renderNotification("attendance.absent", "en", { date: "{amount}" });
    expect(r?.body).toContain("{amount}");
  });
});
