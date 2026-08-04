/**
 * Feste IDs aus dem Board "Support – Beglinger Partners & Lifted".
 * Diese Werte sind keine Geheimnisse (sichtbar für jeden mit Board-Zugriff),
 * deshalb hier im Code statt als Secret.
 *
 * Quelle: Trello-Board am 26.07.2026 gesichtet. Falls Listen/Labels umbenannt
 * oder neu angelegt werden, hier nachziehen (IDs über die Trello-API oder
 * https://trello.com/b/<shortLink>.json abrufbar).
 */

export const BOARD_ID = "6985c8890ea5d7f51c2a8b08";

export const LISTS = {
  inbox: "6a65acb57bc1682efd274681", // "Inbox Viridis (Agent)"
  escalated: "6a65acf06c676f38f92f3aaa", // "Escalated by Viridis"
  backlog: "6a5f18ee366efad49c1746aa",
  inProgress: "6985c8890ea5d7f51c2a8b43",
  blocked: "6985c8ccbd9ba86a4ec4a5f3",
  inReview: "6985c8d5384992effdc0c2c0",
  done: "6985c8890ea5d7f51c2a8b44",
} as const;

export const CATEGORY_LABELS: Record<"Standard" | "Technical" | "Complaint" | "Unclear", string> = {
  Standard: "6a65ad677d2885f6b9d48b47",
  Technical: "6a65ad871314f4b30fddea59",
  Complaint: "6a65adb59673261e033ffc27",
  Unclear: "6a65adbd98ab2be44b0804aa",
};

export const URGENCY_LABELS: Record<"Normal" | "Hoch" | "Kritisch", string> = {
  Normal: "6a65ae1a588093eaa61c3dbb",
  Hoch: "6a65ae229fb8185273e5a6dd",
  Kritisch: "6a65ae26f3b50a4a6f145cdb",
};

// Kunden-Label-ID nach Label-Name. "Unbekannt/Neu" existiert noch nicht als
// Label — bei Bedarf in Trello anlegen und hier ergänzen.
export const CUSTOMER_LABELS: Record<string, string> = {
  "Richmond Events": "6985c8890ea5d7f51c2a8b33",
  "tide ocean": "6985c8890ea5d7f51c2a8b38",
  "Runge Pharma": "6a5a38496a0bf3af2848d75c",
  "Internal": "6985e8fd5ae4138856eeecc6",
  "Beni Huggel": "6985c8890ea5d7f51c2a8b36",
  "NGIB": "6985c8890ea5d7f51c2a8b37",
};

/**
 * Domain-zu-Kunden-Label-Zuordnung.
 * Entspricht Viridis_Domain_Label_Mapping.xlsx (Stand: von Mitch geprüft).
 * Domain in Kleinschreibung, ohne "www.".
 */
export const DOMAIN_TO_CUSTOMER_LABEL: Record<string, string> = {
  "richmondevents.com": "Richmond Events",
  "tide.earth": "tide ocean",
  "rungepharma.de": "Runge Pharma",
  "benihuggel.ch": "Beni Huggel",
  "advocacy.ch": "NGIB",
  "beglingerpartners.com": "Internal",
};

/** Bekannte Infrastruktur-/Vendor-Domains für die Erkennung von System-Benachrichtigungen. */
export const KNOWN_SYSTEM_SENDER_DOMAINS = [
  "cloudflare.com",
  "hover.com",
  "storyblok.com",
  "google.com",
  "trello.com",
];
