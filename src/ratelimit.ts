import type { Env } from "./types";

/**
 * Einfaches Tages-Rate-Limit für kostenpflichtige Anthropic-Aufrufe.
 * Zählt pro Tag (UTC), wie viele Tickets bereits automatisiert verarbeitet
 * (= klassifiziert) wurden. Nutzt den bestehenden VIRIDIS_LOG KV-Namespace,
 * Schlüssel sind nach Datum benannt und räumen sich über expirationTtl
 * selbst auf — kein separater Reset-Job nötig.
 */

const TICKET_COUNT_PREFIX = "ratelimit:tickets:";
const ALERTED_PREFIX = "ratelimit:alerted:";
const ATTEMPTS_PREFIX = "attempts:card:";
const TTL_SECONDS = 60 * 60 * 48; // 2 Tage

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** Anzahl der heute (UTC) bereits automatisiert verarbeiteten Tickets. */
export async function getDailyCount(env: Env): Promise<number> {
  const raw = await env.VIRIDIS_LOG.get(`${TICKET_COUNT_PREFIX}${todayUtc()}`);
  return raw ? Number(raw) || 0 : 0;
}

/** Erhöht den Tageszähler um 1 und gibt den neuen Stand zurück. */
export async function incrementDailyCount(env: Env): Promise<number> {
  const key = `${TICKET_COUNT_PREFIX}${todayUtc()}`;
  const next = (await getDailyCount(env)) + 1;
  await env.VIRIDIS_LOG.put(key, String(next), { expirationTtl: TTL_SECONDS });
  return next;
}

/** Ob heute bereits eine Slack-Warnung wegen des Tageslimits gesendet wurde. */
export async function hasAlertedToday(env: Env): Promise<boolean> {
  const raw = await env.VIRIDIS_LOG.get(`${ALERTED_PREFIX}${todayUtc()}`);
  return raw !== null;
}

/** Merkt sich, dass heute bereits eine Slack-Warnung gesendet wurde. */
export async function markAlertedToday(env: Env): Promise<void> {
  await env.VIRIDIS_LOG.put(`${ALERTED_PREFIX}${todayUtc()}`, "1", { expirationTtl: TTL_SECONDS });
}

/**
 * Fehlversuchszähler pro Karte. Ohne diesen Zähler würde eine Karte, bei der
 * die Verarbeitung immer wieder scheitert (z. B. weil eine präparierte
 * Nachricht das Modell zu Nicht-JSON verleitet), alle 5 Minuten erneut
 * einen bezahlten Anthropic-Aufruf auslösen — unbegrenzt und am Tageslimit
 * vorbei. Nach MAX_CARD_ATTEMPTS wird die Karte ohne KI-Ergebnis eskaliert.
 */
export async function incrementCardAttempts(env: Env, cardId: string): Promise<number> {
  const key = `${ATTEMPTS_PREFIX}${cardId}`;
  const raw = await env.VIRIDIS_LOG.get(key);
  const next = (raw ? Number(raw) || 0 : 0) + 1;
  await env.VIRIDIS_LOG.put(key, String(next), { expirationTtl: TTL_SECONDS });
  return next;
}

export async function clearCardAttempts(env: Env, cardId: string): Promise<void> {
  await env.VIRIDIS_LOG.delete(`${ATTEMPTS_PREFIX}${cardId}`);
}
