// =============================================================================
// Notification messages — the text that actually reaches a parent
// =============================================================================
// Twelve countries in the catalogue are francophone, and the platform speaks only
// English. Translating all ~2,138 UI strings would be the wrong order of work: a
// parent in Dakar or Abidjan rarely opens the web app. They get an SMS saying
// their child was absent, and they get a report card and a fee receipt. Those are
// a hundred-odd strings, and they are close to 100% of what that parent reads.
//
// So the messages that LEAVE the building are localised first, and the screens
// follow later.
//
// Two design points that are expensive to change afterwards:
//
// 1. LANGUAGE IS PER USER, not per school. A Senegalese school has francophone
//    parents and may well have an anglophone principal or a British-curriculum
//    teacher. A school-level setting can never serve both, and retrofitting
//    per-user later means revisiting every producer.
//
// 2. PRODUCERS PASS A KEY AND PARAMS, never a composed sentence. A composed
//    string has already picked a language, and the producer does not know who is
//    about to read it — `enqueueMany` sends one notification to a whole class of
//    guardians who may not share a language. Rendering therefore happens per
//    RECIPIENT, at the moment the row is written.
//
// Callers that still pass a literal title/body keep working and stay English.
// That is deliberate: it makes this an incremental migration rather than a
// big-bang rewrite of 95 call sites, and an untranslated notice in English is a
// far smaller problem than a delivery that fails because its key was missing.
// =============================================================================

/** Languages the messages are written in. A locale like "fr-SN" resolves to "fr". */
export const MESSAGE_LANGUAGES = ["en", "fr"] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];

export const DEFAULT_MESSAGE_LANGUAGE: MessageLanguage = "en";

/** A locale ("fr-CI", "en-NG") narrowed to a language we have text for. */
export function messageLanguage(locale: string | null | undefined): MessageLanguage {
  const base = (locale ?? "").slice(0, 2).toLowerCase();
  return (MESSAGE_LANGUAGES as readonly string[]).includes(base) ? (base as MessageLanguage) : DEFAULT_MESSAGE_LANGUAGE;
}

interface MessageTemplate {
  title: Record<MessageLanguage, string>;
  body: Record<MessageLanguage, string>;
}

/**
 * The catalogue.
 *
 * Every entry carries EVERY language — a partial entry would fall back silently
 * and produce a French inbox with English holes, which reads as a broken product
 * rather than an untranslated one. A test enforces completeness.
 *
 * Placeholders are `{name}` and are substituted verbatim; nothing here formats a
 * date or an amount, because those are already localised by the caller through
 * the region helpers and re-formatting them would give two different answers.
 */
export const NOTIFICATION_MESSAGES: Record<string, MessageTemplate> = {
  // NOTE: no {student} placeholder. The producer notifies a guardian without
  // loading the child's name, and inventing a lookup here would smuggle a
  // behaviour change into a translation. The English wording below is the
  // existing message verbatim, so migrating this producer changes the LANGUAGE
  // and nothing else. Naming the child is a real improvement for a guardian with
  // several — and a separate change.
  "attendance.absent": {
    title: { en: "Attendance alert", fr: "Alerte de présence" },
    body: {
      en: "Your child was marked ABSENT on {date}.",
      fr: "Votre enfant a été porté(e) ABSENT(E) le {date}.",
    },
  },
  "attendance.late": {
    title: { en: "Attendance alert", fr: "Alerte de présence" },
    body: {
      en: "Your child was marked LATE on {date}.",
      fr: "Votre enfant a été porté(e) EN RETARD le {date}.",
    },
  },
  // A correction to an absence or lateness already reported to the family. It
  // must stand on its own — a guardian reading it may not have the earlier one
  // to hand — and it names PRESENT rather than "ignore that", so the message is
  // a statement of the record rather than a retraction of a message.
  "attendance.corrected": {
    title: { en: "Attendance correction", fr: "Correction de présence" },
    body: {
      en: "An earlier message said your child was absent or late on {date}. That has been corrected — the register now records them as PRESENT.",
      fr: "Un message précédent indiquait que votre enfant était absent(e) ou en retard le {date}. Cela a été corrigé : le registre indique maintenant PRÉSENT(E).",
    },
  },
  "fees.payment_received": {
    title: { en: "Payment received", fr: "Paiement reçu" },
    body: {
      en: "We received {amount} for {student}. Outstanding balance: {balance}. Receipt {reference}.",
      fr: "Nous avons reçu {amount} pour {student}. Solde restant : {balance}. Reçu {reference}.",
    },
  },
  "fees.invoice_issued": {
    title: { en: "New invoice", fr: "Nouvelle facture" },
    body: {
      en: "An invoice of {amount} has been issued for {student}, due {date}.",
      fr: "Une facture de {amount} a été émise pour {student}, à régler avant le {date}.",
    },
  },
  "fees.payment_failed": {
    title: { en: "Payment did not go through", fr: "Le paiement n'a pas abouti" },
    body: {
      en: "A payment attempt of {amount} for {student} was not completed. No money has left your account.",
      fr: "Une tentative de paiement de {amount} pour {student} n'a pas abouti. Aucun montant n'a été débité de votre compte.",
    },
  },
  "fees.invoice_overdue": {
    title: { en: "Invoice overdue", fr: "Facture en retard" },
    body: {
      en: "The invoice of {amount} for {student} was due on {date} and is still outstanding.",
      fr: "La facture de {amount} pour {student} était à régler avant le {date} et reste impayée.",
    },
  },
  "reportcard.available": {
    title: { en: "Report card available", fr: "Bulletin disponible" },
    body: {
      en: "{student}'s report card for {term} is now available to download.",
      fr: "Le bulletin de {student} pour {term} est désormais disponible au téléchargement.",
    },
  },
  "document.shared": {
    title: { en: "A document was shared with you", fr: "Un document vous a été transmis" },
    body: {
      en: "{title} is available for {student}.",
      fr: "{title} est disponible pour {student}.",
    },
  },
  "meeting.called": {
    title: { en: "A meeting has been called", fr: "Une réunion est convoquée" },
    body: {
      en: "{audience} — {date} at {location}.",
      fr: "{audience} — le {date} à {location}.",
    },
  },
  /**
   * The other half of `meeting.called`. Announcing a meeting reaches the whole
   * audience — up to every guardian in the school — and withdrawing it reached
   * nobody, so families held a notice for a meeting that had been called off.
   * The same rule this codebase already applies to a withdrawn cover duty, a
   * retracted bus boarding, a corrected absence and a cancelled invoice.
   */
  "meeting.withdrawn": {
    title: { en: "A meeting has been called off", fr: "Une réunion est annulée" },
    body: {
      en: "{audience} — the meeting on {date} is no longer taking place. Nothing is needed from you.",
      fr: "{audience} — la réunion du {date} n'aura pas lieu. Aucune action n'est requise de votre part.",
    },
  },
  "meeting.cohost_added": {
    title: { en: "You have been added to a meeting", fr: "Vous avez été ajouté(e) à une réunion" },
    body: {
      en: "{audience} — {date}. You are listed as attending.",
      fr: "{audience} — le {date}. Vous êtes inscrit(e) comme participant(e).",
    },
  },
  "meeting.booked": {
    title: { en: "Meeting confirmed", fr: "Rendez-vous confirmé" },
    body: {
      en: "Your meeting with {host} about {student} is confirmed for {date}.",
      fr: "Votre rendez-vous avec {host} au sujet de {student} est confirmé pour le {date}.",
    },
  },
  "meeting.cancelled": {
    title: { en: "Meeting cancelled", fr: "Rendez-vous annulé" },
    body: {
      en: "The meeting with {host} on {date} has been cancelled.",
      fr: "Le rendez-vous avec {host} du {date} a été annulé.",
    },
  },
  "exam.scheduled": {
    title: { en: "Exam details", fr: "Informations sur l'examen" },
    body: {
      en: "{student} sits {exam} on {date} in {hall}, seat {seat}.",
      fr: "{student} passe {exam} le {date} en salle {hall}, place {seat}.",
    },
  },
  "account.password_reset": {
    title: { en: "Password reset", fr: "Réinitialisation du mot de passe" },
    body: {
      en: "A password reset was requested for your account. If this was not you, contact the school.",
      fr: "Une réinitialisation du mot de passe a été demandée pour votre compte. Si vous n'êtes pas à l'origine de cette demande, contactez l'école.",
    },
  },
};

export type NotificationMessageKey = keyof typeof NOTIFICATION_MESSAGES;

/**
 * Render a catalogue entry.
 *
 * Returns null for an unknown key rather than throwing or emitting the key
 * itself: a producer that mistypes one must fall back to its literal English
 * text, never send a parent "attendance.absnet". The caller owns that fallback,
 * which is why this reports failure instead of inventing a message.
 */
export function renderNotification(
  key: string,
  language: MessageLanguage,
  params: Record<string, string | number> = {},
): { title: string; body: string } | null {
  const tpl = NOTIFICATION_MESSAGES[key];
  if (!tpl) return null;
  const fill = (s: string) =>
    // An absent parameter leaves the placeholder rather than printing
    // "undefined" — a visible {student} is a bug report; "undefined" is noise.
    s.replace(/\{(\w+)\}/g, (whole, name: string) => (params[name] === undefined ? whole : String(params[name])));
  return {
    title: fill(tpl.title[language] ?? tpl.title[DEFAULT_MESSAGE_LANGUAGE]),
    body: fill(tpl.body[language] ?? tpl.body[DEFAULT_MESSAGE_LANGUAGE]),
  };
}
