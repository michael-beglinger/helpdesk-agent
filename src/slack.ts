import type { Env } from "./types";

/**
 * Slack mrkdwn interpretiert "<...>" speziell (z. B. <!channel>, <!here>,
 * <@USERID>). Kartenname/Kategorie/Dringlichkeit/Begründung stammen ganz
 * oder teilweise aus einer beliebigen, nicht vertrauenswürdigen externen
 * E-Mail — ohne Escaping könnte ein präparierter Betreff wie "<!channel> ..."
 * ungewollt das ganze Team pingen. Escaping nach Slacks eigener Empfehlung:
 * https://api.slack.com/reference/surfaces/formatting#escaping
 */
function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function notifySlackEscalation(
  env: Env,
  input: {
    cardName: string;
    cardUrl: string;
    kategorie: string;
    dringlichkeit: string;
    begruendung: string;
  }
): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;

  const text =
    `:rotating_light: *Viridis: Ticket eskaliert*\n` +
    `*<${input.cardUrl}|${escapeSlackText(input.cardName)}>*\n` +
    `Kategorie: ${escapeSlackText(input.kategorie)} · Dringlichkeit: ${escapeSlackText(input.dringlichkeit)}\n` +
    `${escapeSlackText(input.begruendung)}`;

  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Slack-Webhook ${res.status}: ${errText}`);
  }
}