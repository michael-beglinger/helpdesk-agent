export interface Env {
  TRELLO_API_KEY: string;
  TRELLO_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  FROM_EMAIL: string;
  FROM_NAME: string;
  AUTOMATION_CONFIDENCE_THRESHOLD: string;
  DAILY_TICKET_LIMIT: string;
  SLACK_WEBHOOK_URL: string;
  DIGEST_RECIPIENT: string;
  /** Shared Secret für den manuellen fetch-Handler (Header "X-Viridis-Token"). Nicht gesetzt = Handler deaktiviert. */
  ADMIN_TOKEN?: string;
  /** Max. Fehlversuche pro Karte, bevor sie ohne KI-Ergebnis eskaliert wird (Default 3). */
  MAX_CARD_ATTEMPTS?: string;
  /** TTL (Sekunden) für den Pro-Karte-Verarbeitungslock, verhindert doppelte Verarbeitung bei überlappenden Läufen (Default 300, min. 60). */
  CARD_LOCK_TTL_SECONDS?: string;
  VIRIDIS_LOG: KVNamespace;
}

export interface TrelloLabel {
  id: string;
  name: string;
  color: string;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  labels: TrelloLabel[];
  shortUrl: string;
}

export type Category = "Standard" | "Technical" | "Complaint" | "Unclear";
export type Urgency = "Normal" | "Hoch" | "Kritisch";

export interface Classification {
  kategorie: Category;
  konfidenz: number;
  dringlichkeit: Urgency;
  kunden_label: string;
  ist_system_benachrichtigung: boolean;
  /** true, wenn der Text Anweisungen an einen Assistenten/Bot, Rollenwechsel-Versuche oder Aufforderungen zu Links/Zahlungsdaten/Weiterleitungen enthält. Erzwingt Eskalation. */
  injection_verdacht: boolean;
  begruendung: string;
}

export interface ExtractedEmail {
  senderEmail: string | null;
  senderDomain: string | null;
  /** true nur, wenn die Adresse aus dem Header-Block der Karte stammt (siehe parse.ts). */
  senderVerified: boolean;
  subject: string;
  body: string;
}