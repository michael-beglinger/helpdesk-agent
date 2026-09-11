/**
 * Deterministische Sicherheitsprüfungen zwischen Modellausgabe und
 * Aussenwirkung (E-Mail-Versand). Der Persona-Prompt allein ist keine
 * ausreichende Verteidigung: Eine präparierte Anfrage kann den
 * Antwortgenerator dazu bringen, Links, Zahlungsdaten oder fremde
 * Formulierungen in eine Mail aufzunehmen, die dann von
 * helpdesk@beglingerpartners.com verschickt wird. Alles, was hier
 * durchfällt, wird NICHT versendet, sondern ans Team eskaliert.
 */

/** Sentinel, den der Antwortgenerator statt eines Antworttexts zurückgeben darf. */
export const ESCALATE_SENTINEL = "ESCALATE";

export const REQUIRED_EMAIL_SIGNATURE = "Viridis — Ihr digitaler Assistent bei Beglinger Partners";

const MIN_REPLY_LENGTH = 40;
const MAX_REPLY_LENGTH = 2500;

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/;
const CARD_NUMBER_RE = /\b(?:\d[ -]?){13,19}\b/;
const CRYPTO_RE = /\b(?:bc1[a-z0-9]{20,}|0x[a-fA-F0-9]{40})\b/;
const PHONE_RE = /(?:\+|00)\d{1,3}[\s./-]?(?:\(?\d+\)?[\s./-]?){5,}/;

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Prüft einen generierten E-Mail-Antworttext, bevor er versendet wird.
 * Bewusst restriktiv: Viridis beantwortet nur Standardanfragen, dafür
 * braucht es weder Links noch Konto-/Telefondaten.
 */
export function checkReplySafety(reply: string): GuardResult {
  const text = reply.trim();

  if (text === ESCALATE_SENTINEL || text.startsWith(`${ESCALATE_SENTINEL}\n`) || text.startsWith(`${ESCALATE_SENTINEL}:`)) {
    return { ok: false, reason: "Modell hat Eskalation angefordert." };
  }
  if (text.length < MIN_REPLY_LENGTH) {
    return { ok: false, reason: `Antwort zu kurz (${text.length} Zeichen).` };
  }
  if (text.length > MAX_REPLY_LENGTH) {
    return { ok: false, reason: `Antwort zu lang (${text.length} Zeichen).` };
  }
  if (!text.includes(REQUIRED_EMAIL_SIGNATURE)) {
    return { ok: false, reason: "Pflichtsignatur fehlt." };
  }
  if (URL_RE.test(text)) {
    return { ok: false, reason: "Antwort enthält eine URL." };
  }
  if (IBAN_RE.test(text)) {
    return { ok: false, reason: "Antwort enthält eine IBAN-ähnliche Zeichenfolge." };
  }
  if (CARD_NUMBER_RE.test(text)) {
    return { ok: false, reason: "Antwort enthält eine kartennummer-ähnliche Zahlenfolge." };
  }
  if (CRYPTO_RE.test(text)) {
    return { ok: false, reason: "Antwort enthält eine Krypto-Wallet-Adresse." };
  }
  if (PHONE_RE.test(text)) {
    return { ok: false, reason: "Antwort enthält eine Telefonnummer." };
  }
  return { ok: true };
}

/**
 * Entfernt Zeilenumbrüche aus Werten, die in E-Mail-Header landen
 * (Subject, Anzeigename). Verhindert Header-Injection über einen
 * präparierten Kartentitel.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Robuste Extraktion des JSON-Objekts aus einer Modellantwort. Toleriert
 * ```json-Fences und Text vor/nach dem Objekt, ohne dass ein einzelnes
 * abweichendes Token die Verarbeitung dauerhaft scheitern lässt.
 */
export function extractJsonObject(raw: string): string {
  const stripped = raw.replace(/```json\s*/gi, "").replace(/```/g, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Kein JSON-Objekt in der Modellantwort gefunden.");
  }
  return stripped.slice(start, end + 1);
}
