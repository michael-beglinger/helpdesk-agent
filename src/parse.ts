import type { ExtractedEmail, TrelloCard } from "./types";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const FROM_LINE_RE = /^\s*(?:From|Von)\s*:\s*.*?(?:<)?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:>)?\s*$/i;

/**
 * Anzahl Zeilen am Anfang der Kartenbeschreibung, in denen eine
 * "From:"/"Von:"-Zeile als Header-Block (und nicht als Teil des Mail-Textes)
 * akzeptiert wird. Der Wert ist bewusst klein: Alles, was tiefer im Text
 * steht, wurde vom Absender selbst geschrieben und ist damit fälschbar.
 */
const HEADER_BLOCK_LINES = 4;

/**
 * Extrahiert Absenderadresse und Text aus einer per E-Mail erzeugten Trello-Karte.
 *
 * SICHERHEIT: Titel und Beschreibung stammen vollständig vom externen
 * Absender. Eine Adresse, die irgendwo im Text steht, ist deshalb KEIN
 * Beleg dafür, wer die Mail geschickt hat — ein Angreifer kann eine fremde
 * Kundenadresse oder eine Vendor-Domain (z. B. cloudflare.com) einfach in
 * den Text schreiben, um ein Kunden-Label zu erschleichen, eine
 * Auto-Antwort an Dritte auszulösen oder als System-Benachrichtigung still
 * im Backlog zu verschwinden.
 *
 * Deshalb liefert diese Funktion zwei Stufen:
 * - `senderEmail`/`senderDomain`: bestmögliche Extraktion (für Anzeige,
 *   Kommentare, Hinweise ans Team) — unverifiziert.
 * - `senderVerified`: true NUR, wenn die Adresse aus einer "From:"/"Von:"-
 *   Zeile innerhalb der ersten HEADER_BLOCK_LINES Zeilen der Beschreibung
 *   stammt, d. h. aus dem Header-Block, den Trellos "E-Mail an Board"
 *   voranstellt. Nur verifizierte Absender dürfen eine automatische
 *   Antwort oder eine System-Benachrichtigungs-Einstufung auslösen.
 *
 * ACHTUNG — NOCH ZU VERIFIZIEREN: Das genaue Kartenformat von Trellos
 * "E-Mail an Board" (siehe README, "Unbedingt vor dem produktiven Einsatz
 * prüfen"). Sobald das Format bekannt ist, sollte `senderVerified`
 * ausschliesslich aus dem echten Header-Feld abgeleitet werden. Bis dahin
 * ist die Header-Block-Regel oben die konservative Näherung.
 */
export function extractEmailFromCard(card: TrelloCard): ExtractedEmail {
  const descLines = card.desc.split(/\r?\n/);
  const headerBlock = descLines.slice(0, HEADER_BLOCK_LINES);

  let verifiedEmail: string | null = null;
  for (const line of headerBlock) {
    const m = line.match(FROM_LINE_RE);
    if (m) {
      verifiedEmail = m[1];
      break;
    }
  }

  const haystack = `${card.name}\n${card.desc}`;
  const anyEmailMatch = haystack.match(EMAIL_RE);

  const senderEmail = verifiedEmail ?? anyEmailMatch?.[0] ?? null;
  const senderDomain = senderEmail ? senderEmail.split("@")[1]?.toLowerCase() ?? null : null;

  return {
    senderEmail,
    senderDomain,
    senderVerified: verifiedEmail !== null,
    subject: card.name,
    body: card.desc,
  };
}

/**
 * Extrahiert den Kundennamen aus dem Titel einer manuell angelegten
 * WhatsApp-Karte. Konvention (siehe README): "<Kunde> – New WhatsApp Request".
 *
 * ACHTUNG: Reine Team-Konvention, nicht von Trello erzwungen. Erwartet wird
 * der Kundenname als Präfix vor dem ersten Trenner " - " / " – " / " — "
 * (Bindestrich, En- oder Em-Dash, jeweils von Leerzeichen umgeben). Ohne
 * einen solchen Trenner wird NICHT der gesamte Titel als Name zurückgegeben
 * (Gefahr stiller Fehlzuordnungen) — es wird null geliefert.
 */
export function extractCustomerNameFromWhatsAppCard(card: TrelloCard): string | null {
  const match = card.name.match(/^\s*(.+?)\s[-–—]\s/);
  if (!match) return null;
  const name = match[1].trim();
  return name.length > 0 ? name : null;
}
