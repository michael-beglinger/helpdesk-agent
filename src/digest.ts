import type { Env } from "./types";
import { sendEmail } from "./email";

const PREFIX = "ticket:";

export type TicketStatus = "beantwortet" | "eskaliert" | "vorschlag";

interface TicketLogEntry {
  cardName: string;
  cardUrl: string;
  status: TicketStatus;
  kategorie?: string;
  dringlichkeit?: string;
  at: string;
}

export async function logTicket(
  env: Env,
  input: {
    cardName: string;
    cardUrl: string;
    status: TicketStatus;
    kategorie?: string;
    dringlichkeit?: string;
  }
): Promise<void> {
  const key = `${PREFIX}${Date.now()}:${crypto.randomUUID()}`;
  const entry: TicketLogEntry = {
    cardName: input.cardName,
    cardUrl: input.cardUrl,
    status: input.status,
    kategorie: input.kategorie,
    dringlichkeit: input.dringlichkeit,
    at: new Date().toISOString(),
  };
  await env.VIRIDIS_LOG.put(key, JSON.stringify(entry));
}

export async function sendDailyDigest(env: Env): Promise<void> {
  const list = await env.VIRIDIS_LOG.list({ prefix: PREFIX });

  if (list.keys.length === 0) return;

  const entries: TicketLogEntry[] = [];
  for (const k of list.keys) {
    const raw = await env.VIRIDIS_LOG.get(k.name);
    if (raw) entries.push(JSON.parse(raw) as TicketLogEntry);
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));

  const beantwortet = entries.filter((e) => e.status === "beantwortet");
  const eskaliert = entries.filter((e) => e.status === "eskaliert");
  const vorschlag = entries.filter((e) => e.status === "vorschlag");

  const sections: string[] = [];
  if (beantwortet.length > 0) {
    sections.push(
      [
        `Automatisiert beantwortet (${beantwortet.length}):`,
        ...beantwortet.map((e, i) => `${i + 1}. ${e.cardName} — ${e.cardUrl}`),
      ].join("\n")
    );
  }
  if (eskaliert.length > 0) {
    sections.push(
      [
        `Eskaliert (${eskaliert.length}):`,
        ...eskaliert.map(
          (e, i) =>
            `${i + 1}. ${e.cardName}${e.kategorie ? ` (${e.kategorie}${e.dringlichkeit ? ", " + e.dringlichkeit : ""})` : ""} — ${e.cardUrl}`
        ),
      ].join("\n")
    );
  }
  if (vorschlag.length > 0) {
    sections.push(
      [
        `WhatsApp – Antwortvorschlag erstellt (${vorschlag.length}):`,
        ...vorschlag.map(
          (e, i) =>
            `${i + 1}. ${e.cardName}${e.kategorie ? ` (${e.kategorie}${e.dringlichkeit ? ", " + e.dringlichkeit : ""})` : ""} — ${e.cardUrl}`
        ),
      ].join("\n")
    );
  }

  const text = [
    `Viridis hat seit der letzten Zusammenfassung ${entries.length} Support-Anfrage(n) bearbeitet:`,
    "",
    ...sections.join("\n\n").split("\n"),
  ].join("\n");

  await sendEmail(env, {
    to: env.DIGEST_RECIPIENT,
    subject: `Viridis – Tagesübersicht Support-Anfragen (${entries.length})`,
    text,
  });

  await Promise.all(list.keys.map((k) => env.VIRIDIS_LOG.delete(k.name)));
}