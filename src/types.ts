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
  begruendung: string;
}

export interface ExtractedEmail {
  senderEmail: string | null;
  senderDomain: string | null;
  subject: string;
  body: string;
}