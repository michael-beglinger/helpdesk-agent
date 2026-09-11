/**
 * Leichte Tests ohne Live-API-Aufrufe: prüfen die reine Logik
 * (Absender-Extraktion, Domain-Mapping, "unbearbeitet"-Erkennung).
 * Ausführen mit: npm test  (nutzt tsx, kein Build-Schritt nötig)
 */
import { extractCustomerNameFromWhatsAppCard, extractEmailFromCard } from "../src/parse";
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
