import type { ExtractedEmail, TrelloCard } from "./types";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/**
 * Extrahiert Absenderadresse und Text aus einer per E-Mail erzeugten Trello-Karte.
 *
 * ACHTUNG — NOCH ZU VERIFIZIEREN:
 * Trellos "E-Mail an Board"-Funktion hat kein fest dokumentiertes Format für
 * die Platzierung der Absenderadresse. Diese Funktion versucht mehrere
 * bekannte Muster (Beschreibungstext, "From:"-Zeile). Sobald die erste
 * echte Test-Mail durch den Workflow gelaufen ist (siehe Workflow-Dokument,
 * Abschnitt 6 "Testphase"), bitte die tatsächliche Kartenstruktur prüfen und
 * diese Funktion bei Bedarf anpassen — am einfachsten über die Trello-API:
 * GET https://api.trello.com/1/cards/{id}?fields=desc,name&key=...&token=...
 */
export function extractEmailFromCard(card: TrelloCard): ExtractedEmail {
  const haystack = `${card.name}\n${card.desc}`;

  // Häufigstes Muster: "From: Name <email@domain.com>" oder "Von: ..."
  const fromLineMatch = haystack.match(/(?:From|Von)\s*:?\s*.*?(<)?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(>)?/i);
  const anyEmailMatch = haystack.match(EMAIL_RE);

  const senderEmail = fromLineMatch?.[2] ?? anyEmailMatch?.[0] ?? null;
  const senderDomain = senderEmail ? senderEmail.split("@")[1]?.toLowerCase() ?? null : null;

  return {
    senderEmail,
    senderDomain,
    subject: card.name,
    body: card.desc,
  };
}
