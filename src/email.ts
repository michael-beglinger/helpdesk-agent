import type { Env } from "./types";

/**
 * Versand über die Gmail API mit einem Google-Dienstkonto (domainweite
 * Delegation), im Namen von helpdesk@beglingerpartners.com.
 *
 * Ablauf: Dienstkonto signiert einen JWT (RS256, über Web Crypto — keine
 * externe Bibliothek nötig), tauscht ihn gegen ein Access Token, und ruft
 * damit die Gmail API auf. Voraussetzung: die Domain-Freigabe in der Google
 * Workspace Admin-Konsole (Sicherheit → API-Steuerung → Domainweite
 * Delegierung) für den Scope "https://www.googleapis.com/auth/gmail.send".
 */

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export function toBase64(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function toBase64Url(input: string | ArrayBuffer): string {
  return toBase64(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Wandelt den PEM-Private-Key aus der Google-JSON-Key-Datei in ein
 * ArrayBuffer um. Funktioniert sowohl, wenn die Zeilenumbrüche als
 * tatsächliche Newlines vorliegen, als auch, wenn sie (wie im rohen
 * JSON-String) als literale "\n"-Zeichenfolgen kopiert wurden.
 */
export function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function getAccessToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: GMAIL_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
    // "sub": im Namen dieser Adresse senden (funktioniert nur dank
    // domainweiter Delegation in der Workspace Admin-Konsole).
    sub: env.FROM_EMAIL,
  };

  const signingInput = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(claims))}`;
  const key = await importPrivateKey(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${toBase64Url(signature)}`;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google-OAuth-Token-Anfrage fehlgeschlagen (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/** Kodiert einen Header-Wert nach RFC 2047, falls er Nicht-ASCII-Zeichen enthält (z. B. Umlaute). */
export function encodeHeaderValue(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${toBase64(value)}?=`;
}

export function buildRawMessage(input: { fromEmail: string; fromName: string; to: string; subject: string; text: string }): string {
  const lines = [
    `From: ${encodeHeaderValue(input.fromName)} <${input.fromEmail}>`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    input.text,
  ];
  return lines.join("\r\n");
}

export async function sendEmail(
  env: Env,
  input: { to: string; subject: string; text: string; inReplyToSubject?: string }
): Promise<void> {
  const accessToken = await getAccessToken(env);
  const subject = input.inReplyToSubject ? `Re: ${input.inReplyToSubject}` : input.subject;
  const raw = buildRawMessage({
    fromEmail: env.FROM_EMAIL,
    fromName: env.FROM_NAME,
    to: input.to,
    subject,
    text: input.text,
  });

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(env.FROM_EMAIL)}/messages/send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ raw: toBase64Url(raw) }),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail API ${res.status}: ${text}`);
  }
}
