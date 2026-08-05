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
