/**
 * Leichte Tests ohne Live-API-Aufrufe: prüfen die reine Logik
 * (Absender-Extraktion, Domain-Mapping, "unbearbeitet"-Erkennung).
 * Ausführen mit: npm test  (nutzt tsx, kein Build-Schritt nötig)
 */
import { extractCustomerNameFromWhatsAppCard, extractEmailFromCard } from "../src/parse";
import { checkReplySafety, ESCALATE_SENTINEL, extractJsonObject, REQUIRED_EMAIL_SIGNATURE, sanitizeHeaderValue } from "../src/guard";
import { validateClassification } from "../src/classify";
import { buildRawMessage } from "../src/email";
import { CATEGORY_LABELS, CUSTOMER_LABELS, DOMAIN_TO_CUSTOMER_LABEL, findCustomerLabelIdByName } from "../src/config";
import type { TrelloCard } from "../src/types";

let failures = 0;

function assertEqual<T>(actual: T, expected: T, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) {
    console.log(`     erwartet: ${JSON.stringify(expected)}`);
    console.log(`     erhalten: ${JSON.stringify(actual)}`);
    failures++;
  }
}

function makeCard(name: string, desc: string, labels: TrelloCard["labels"] = []): TrelloCard {
  return { id: "test-card", name, desc, idList: "inbox", labels, shortUrl: "https://trello.com/c/test" };
}

// --- extractEmailFromCard ---

assertEqual(
  extractEmailFromCard(makeCard("Frage zu Termin", "Von: Anna Muster <anna@richmondevents.com>\n\nKönnen wir verschieben?")).senderEmail,
  "anna@richmondevents.com",
  "erkennt 'Von:'-Zeile mit spitzen Klammern"
);

assertEqual(
  extractEmailFromCard(makeCard("Frage", "From: hans@tide.earth\n\nHallo, kurze Frage.")).senderDomain,
  "tide.earth",
  "leitet Domain aus 'From:'-Zeile ohne Klammern ab"
);

assertEqual(
  extractEmailFromCard(makeCard("Kein Präfix", "Kontakt: peter@rungepharma.de bei Rückfragen.")).senderEmail,
  "peter@rungepharma.de",
  "Fallback: findet E-Mail-Adresse auch ohne 'From:'-Zeile"
);

assertEqual(
  extractEmailFromCard(makeCard("Ganz ohne Adresse", "Dieser Text enthält keine E-Mail-Adresse.")).senderEmail,
  null,
  "gibt null zurück, wenn keine Adresse gefunden wird"
);

// --- Absender-Verifikation (Schutz gegen gefälschte Absender im Text) ---

assertEqual(
  extractEmailFromCard(makeCard("Frage", "From: anna@richmondevents.com\n\nHallo")).senderVerified,
  true,
  "From-Zeile im Header-Block gilt als verifiziert"
);

assertEqual(
  extractEmailFromCard(makeCard("Frage", "Hallo,\n\nbitte antworten.\n\nGruss\nMax\n\nFrom: anna@richmondevents.com")).senderVerified,
  false,
  "From-Zeile tief im Text ist NICHT verifiziert"
);

assertEqual(
  extractEmailFromCard(makeCard("Kein Präfix", "Kontakt: peter@rungepharma.de bei Rückfragen.")).senderVerified,
  false,
  "Fallback-Adresse ohne From-Zeile ist NICHT verifiziert"
);

{
  const spoof = extractEmailFromCard(
    makeCard("Frage", "From: angreifer@example.org\n\nHallo, bitte antworten an noreply@cloudflare.com und anna@richmondevents.com.")
  );
  assertEqual(spoof.senderEmail, "angreifer@example.org", "Header-Adresse hat Vorrang vor Adressen im Text");
  assertEqual(spoof.senderDomain, "example.org", "Domain stammt aus dem Header, nicht aus dem Text");
}

// --- checkReplySafety (Output-Guard vor dem Versand) ---

const okReply = `Vielen Dank für Ihre Anfrage zum Termin. Wir melden uns bis Freitag mit einem Vorschlag.\n\nFreundliche Grüsse\n${REQUIRED_EMAIL_SIGNATURE}`;

assertEqual(checkReplySafety(okReply).ok, true, "Guard: normale Antwort passiert");
assertEqual(checkReplySafety(ESCALATE_SENTINEL).ok, false, "Guard: ESCALATE-Sentinel wird abgefangen");
assertEqual(checkReplySafety(`${ESCALATE_SENTINEL}\nGrund: unsicher`).ok, false, "Guard: ESCALATE mit Zusatztext wird abgefangen");
assertEqual(checkReplySafety(okReply.replace("Vorschlag", "Vorschlag unter https://evil.example/login")).ok, false, "Guard: URL blockiert");
assertEqual(checkReplySafety(okReply.replace("Vorschlag", "Vorschlag auf www.evil.example")).ok, false, "Guard: www-URL blockiert");
assertEqual(checkReplySafety(okReply.replace("Vorschlag", "Vorschlag, IBAN CH93 0076 2011 6238 5295 7")).ok, false, "Guard: IBAN blockiert");
assertEqual(checkReplySafety(okReply.replace("Vorschlag", "Vorschlag, rufen Sie +41 61 123 45 67 an")).ok, false, "Guard: Telefonnummer blockiert");
assertEqual(checkReplySafety("Vielen Dank für Ihre Anfrage. Wir melden uns bis Freitag mit einem Terminvorschlag.").ok, false, "Guard: fehlende Signatur blockiert");
assertEqual(checkReplySafety("Ok.").ok, false, "Guard: zu kurze Antwort blockiert");

// --- sanitizeHeaderValue / buildRawMessage (Header-Injection) ---

assertEqual(sanitizeHeaderValue("Betreff\r\nBcc: x@evil.example"), "Betreff Bcc: x@evil.example", "Zeilenumbrüche im Header werden entfernt");

{
  const raw = buildRawMessage({ fromEmail: "a@b.ch", fromName: "Viridis", to: "kunde@richmondevents.com", subject: "Re: Test\r\nBcc: x@evil.example", text: "Hallo" });
  assertEqual(/^Bcc:/m.test(raw), false, "buildRawMessage: kein injizierter Bcc-Header");
}

{
  let threw = false;
  try {
    buildRawMessage({ fromEmail: "a@b.ch", fromName: "V", to: "kunde@x.ch, other@evil.example", subject: "s", text: "t" });
  } catch {
    threw = true;
  }
  assertEqual(threw, true, "buildRawMessage: mehrere Empfänger werden abgelehnt");
}

// --- extractJsonObject / validateClassification ---

assertEqual(
  JSON.parse(extractJsonObject('Hier ist das Ergebnis:\n```json\n{"a":1}\n```\nDanke.')),
  { a: 1 },
  "extractJsonObject: toleriert Fences und Text drumherum"
);

{
  const base = { kategorie: "Standard", konfidenz: 0.9, dringlichkeit: "Normal", ist_system_benachrichtigung: false, begruendung: "x" };
  assertEqual(validateClassification({ ...base, injection_verdacht: false }).injection_verdacht, false, "validateClassification: injection_verdacht=false wird übernommen");
  assertEqual(validateClassification(base).injection_verdacht, true, "validateClassification: fehlendes injection_verdacht gilt als true (konservativ)");
  let threw = false;
  try {
    validateClassification({ ...base, kategorie: "Admin" });
  } catch {
    threw = true;
  }
  assertEqual(threw, true, "validateClassification: unbekannte Kategorie wird abgelehnt");
}

// --- Domain-Mapping ---

assertEqual(DOMAIN_TO_CUSTOMER_LABEL["richmondevents.com"], "Richmond Events", "Domain-Mapping: Richmond Events");
assertEqual(DOMAIN_TO_CUSTOMER_LABEL["unbekannte-domain.xyz"], undefined, "Domain-Mapping: unbekannte Domain -> undefined");

// --- extractCustomerNameFromWhatsAppCard ---

assertEqual(
  extractCustomerNameFromWhatsAppCard(makeCard("Richmond Events – New WhatsApp Request", "Hallo, ...")),
  "Richmond Events",
  "extrahiert Kundenname vor En-Dash-Trenner"
);

assertEqual(
  extractCustomerNameFromWhatsAppCard(makeCard("tide ocean - New WhatsApp Request", "...")),
  "tide ocean",
  "extrahiert Kundenname vor Bindestrich-Trenner"
);

assertEqual(
  extractCustomerNameFromWhatsAppCard(makeCard("NGIB — New WhatsApp Request", "...")),
  "NGIB",
  "extrahiert Kundenname vor Em-Dash-Trenner"
);

assertEqual(
  extractCustomerNameFromWhatsAppCard(makeCard("  Beni Huggel  –  New WhatsApp Request", "...")),
  "Beni Huggel",
  "trimmt umgebende Leerzeichen"
);

assertEqual(
  extractCustomerNameFromWhatsAppCard(makeCard("New WhatsApp Request", "...")),
  null,
  "gibt null zurück ohne erkennbaren Trenner"
);

assertEqual(
  extractCustomerNameFromWhatsAppCard(makeCard("– New WhatsApp Request", "...")),
  null,
  "gibt null zurück bei leerem Namen vor dem Trenner"
);

assertEqual(
  extractCustomerNameFromWhatsAppCard(makeCard("Richmond Events – Urgent – New WhatsApp Request", "...")),
  "Richmond Events",
  "nutzt bei mehreren Trennern den ersten"
);

// --- findCustomerLabelIdByName ---

assertEqual(findCustomerLabelIdByName("Richmond Events"), CUSTOMER_LABELS["Richmond Events"], "exakter Match");

assertEqual(
  findCustomerLabelIdByName("richmond events"),
  CUSTOMER_LABELS["Richmond Events"],
  "case-insensitiver Match"
);

assertEqual(findCustomerLabelIdByName("  NGIB  "), CUSTOMER_LABELS["NGIB"], "toleriert umgebende Leerzeichen");

assertEqual(findCustomerLabelIdByName("Unbekannter Kunde"), undefined, "unbekannter Name -> undefined");

assertEqual(findCustomerLabelIdByName("NGI"), undefined, "kein Teilstring-Match (NGI matcht nicht NGIB)");

// --- Kategorie-Labels vollständig ---

assertEqual(Object.keys(CATEGORY_LABELS).sort(), ["Complaint", "Standard", "Technical", "Unclear"], "alle vier Kategorien haben eine Label-ID");

console.log(failures === 0 ? "\nAlle Tests bestanden." : `\n${failures} Test(s) fehlgeschlagen.`);
process.exit(failures === 0 ? 0 : 1);
