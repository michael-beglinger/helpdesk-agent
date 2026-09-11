import {
  addCommentToCard,
  addLabelToCard,
  getCardsInList,
  markCardComplete,
  moveCardToList,
} from "./trello";
import { classifyEmail, classifyWhatsAppMessage } from "./classify";
import { generateStandardReply, generateWhatsAppReplySuggestion } from "./reply";
import { sendEmail } from "./email";
import { extractCustomerNameFromWhatsAppCard, extractEmailFromCard } from "./parse";
import { notifySlackEscalation } from "./slack";
import { logTicket, sendDailyDigest } from "./digest";
import {
  getDailyCount,
  hasAlertedToday,
  incrementDailyCount,
  markAlertedToday,
} from "./ratelimit";
import {
  CATEGORY_LABELS,
  CUSTOMER_LABELS,
  DOMAIN_TO_CUSTOMER_LABEL,
  findCustomerLabelIdByName,
  LISTS,
  URGENCY_LABELS,
} from "./config";
import type { Env, TrelloCard } from "./types";

const DIGEST_CRON = "0 16 * * *";

const ALL_CATEGORY_LABEL_IDS = new Set(Object.values(CATEGORY_LABELS));

function isUnprocessed(card: TrelloCard): boolean {
  return !card.labels.some((l) => ALL_CATEGORY_LABEL_IDS.has(l.id));
}

async function processCard(env: Env, card: TrelloCard): Promise<void> {
  const email = extractEmailFromCard(card);

  const classification = await classifyEmail(env, {
    subject: email.subject,
    body: email.body,
    senderDomain: email.senderDomain,
  });

  const customerName = email.senderDomain
    ? DOMAIN_TO_CUSTOMER_LABEL[email.senderDomain]
    : undefined;
  const customerLabelId = customerName ? CUSTOMER_LABELS[customerName] : undefined;

  await addLabelToCard(env, card.id, CATEGORY_LABELS[classification.kategorie]);
  await addLabelToCard(env, card.id, URGENCY_LABELS[classification.dringlichkeit]);
  if (customerLabelId) await addLabelToCard(env, card.id, customerLabelId);

  if (!customerName) {
    await addCommentToCard(
      env,
      card.id,
      `⚠️ Viridis: Absenderdomain "${email.senderDomain ?? "unbekannt"}" ist keinem Kunden-Label zugeordnet. Bitte Viridis_Domain_Label_Mapping ergänzen.`
    );
  }

  if (classification.ist_system_benachrichtigung) {
    await addCommentToCard(
      env,
      card.id,
      `Viridis: als System-Benachrichtigung erkannt (${classification.begruendung}). Keine Kundenantwort, keine Eskalation.`
    );
    await moveCardToList(env, card.id, LISTS.backlog);
    return;
  }

  const threshold = Number(env.AUTOMATION_CONFIDENCE_THRESHOLD || "0.85");
  const canAutomate =
    classification.kategorie === "Standard" &&
    classification.konfidenz >= threshold &&
    !!email.senderEmail;

  if (canAutomate && email.senderEmail) {
    const replyText = await generateStandardReply(env, {
      subject: email.subject,
      body: email.body,
    });

    await sendEmail(env, {
      to: email.senderEmail,
      subject: email.subject,
      text: replyText,
      inReplyToSubject: email.subject,
    });

    await addCommentToCard(
      env,
      card.id,
      `Viridis hat automatisiert geantwortet (Konfidenz ${classification.konfidenz.toFixed(2)}):\n\n${replyText}`
    );
    await moveCardToList(env, card.id, LISTS.doneByViridis);
    await markCardComplete(env, card.id);

    try {
      await logTicket(env, { cardName: card.name, cardUrl: card.shortUrl, status: "beantwortet" });
    } catch (err) {
      console.error(`Digest-Protokollierung fehlgeschlagen für Karte ${card.id}:`, err);
    }
    return;
  }

  const reasonNote = !email.senderEmail
    ? " Zusätzlicher Grund: keine Absenderadresse erkannt — bitte Kartenformat prüfen (siehe parse.ts)."
    : "";
  await addCommentToCard(
    env,
    card.id,
    `Viridis: Eskalation an das Team.\nKategorie: ${classification.kategorie} · Dringlichkeit: ${classification.dringlichkeit} · Konfidenz: ${classification.konfidenz.toFixed(2)}\nBegründung: ${classification.begruendung}${reasonNote}`
  );
  await moveCardToList(env, card.id, LISTS.escalated);

  try {
    await notifySlackEscalation(env, {
      cardName: card.name,
      cardUrl: card.shortUrl,
      kategorie: classification.kategorie,
      dringlichkeit: classification.dringlichkeit,
      begruendung: classification.begruendung + reasonNote,
    });
  } catch (err) {
    console.error(`Slack-Benachrichtigung fehlgeschlagen für Karte ${card.id}:`, err);
  }
  try {
    await logTicket(env, {
      cardName: card.name,
      cardUrl: card.shortUrl,
      status: "eskaliert",
      kategorie: classification.kategorie,
      dringlichkeit: classification.dringlichkeit,
    });
  } catch (err) {
    console.error(`Digest-Protokollierung fehlgeschlagen für Karte ${card.id}:`, err);
  }
}

/**
 * WhatsApp-Pendant zu processCard: Kartenbeschreibung ist die rohe
 * WhatsApp-Nachricht (manuell vom Team angelegt, siehe README). Kunden-Label
 * wird aus dem Kartentitel abgeleitet (Konvention "<Kunde> – ...", siehe
 * extractCustomerNameFromWhatsAppCard in parse.ts) und case-insensitiv gegen
 * CUSTOMER_LABELS aufgelöst — keine Telefonnummer-Zuordnung. Kein
 * automatischer Versand — Viridis schlägt nur eine Antwort als Kommentar
 * vor, die manuell in WhatsApp Business eingefügt wird.
 */
async function processWhatsAppCard(env: Env, card: TrelloCard): Promise<void> {
  const classification = await classifyWhatsAppMessage(env, { body: card.desc });

  const customerNameRaw = extractCustomerNameFromWhatsAppCard(card);
  const customerLabelId = customerNameRaw ? findCustomerLabelIdByName(customerNameRaw) : undefined;

  await addLabelToCard(env, card.id, CATEGORY_LABELS[classification.kategorie]);
  await addLabelToCard(env, card.id, URGENCY_LABELS[classification.dringlichkeit]);
  if (customerLabelId) await addLabelToCard(env, card.id, customerLabelId);

  if (!customerLabelId) {
    await addCommentToCard(
      env,
      card.id,
      customerNameRaw
        ? `⚠️ Viridis: Name "${customerNameRaw}" im Kartentitel ist keinem Kunden-Label zugeordnet. Bitte Kartentitel oder CUSTOMER_LABELS in config.ts prüfen.`
        : `⚠️ Viridis: Kein Kundenname im Kartentitel erkannt (erwartet "<Kunde> – ..."). Kein Kunden-Label gesetzt.`
    );
  }

  if (classification.ist_system_benachrichtigung) {
    await addCommentToCard(
      env,
      card.id,
      `Viridis: als automatisierte Nachricht erkannt (${classification.begruendung}). Kein Antwortvorschlag erstellt.`
    );
    await moveCardToList(env, card.id, LISTS.backlog);
    return;
  }

  const replyText = await generateWhatsAppReplySuggestion(env, { body: card.desc });

  await addCommentToCard(
    env,
    card.id,
    `Viridis schlägt folgende Antwort vor (bitte manuell in WhatsApp Business einfügen):\nKategorie: ${classification.kategorie} · Dringlichkeit: ${classification.dringlichkeit} · Konfidenz: ${classification.konfidenz.toFixed(2)}\n\n${replyText}`
  );
  await moveCardToList(env, card.id, LISTS.backlog);

  try {
    await logTicket(env, {
      cardName: card.name,
      cardUrl: card.shortUrl,
      status: "vorschlag",
      kategorie: classification.kategorie,
      dringlichkeit: classification.dringlichkeit,
    });
  } catch (err) {
    console.error(`Digest-Protokollierung fehlgeschlagen für Karte ${card.id}:`, err);
  }
}

/**
 * Tages-Rate-Limit erreicht: Karte wird ohne (kostenpflichtige) KI-
 * Klassifizierung direkt ans Team eskaliert, statt liegen zu bleiben.
 * Pro Tag wird nur einmal eine Slack-Warnung verschickt, nicht bei jeder
 * betroffenen Karte einzeln. `targetList` unterscheidet E-Mail (Escalated)
 * von WhatsApp (Backlog, da dort kein separates Eskalations-Listen-Konzept
 * existiert) — das geteilte Tageslimit gilt für beide Kanäle gemeinsam,
 * da es die gesamten Anthropic-Kosten begrenzen soll.
 */
async function escalateForDailyLimit(
  env: Env,
  card: TrelloCard,
  limit: number,
  targetList: string
): Promise<void> {
  await addCommentToCard(
    env,
    card.id,
    `⚠️ Viridis: Tages-Limit von ${limit} automatisiert verarbeiteten Tickets erreicht. Karte wird ohne KI-Klassifizierung direkt ans Team eskaliert. Das Limit setzt sich um Mitternacht (UTC) zurück.`
  );
  await moveCardToList(env, card.id, targetList);

  if (!(await hasAlertedToday(env))) {
    try {
      await notifySlackEscalation(env, {
        cardName: card.name,
        cardUrl: card.shortUrl,
        kategorie: "—",
        dringlichkeit: "—",
        begruendung: `Tages-Limit von ${limit} Anthropic-Aufrufen erreicht. Weitere Tickets werden bis Mitternacht (UTC) ohne KI-Klassifizierung direkt ans Team eskaliert.`,
      });
    } catch (err) {
      console.error("Slack-Benachrichtigung (Tageslimit) fehlgeschlagen:", err);
    }
    await markAlertedToday(env);
  }

  try {
    await logTicket(env, { cardName: card.name, cardUrl: card.shortUrl, status: "eskaliert" });
  } catch (err) {
    console.error(`Digest-Protokollierung fehlgeschlagen für Karte ${card.id}:`, err);
  }
}

interface QueueItem {
  channel: "email" | "whatsapp";
  card: TrelloCard;
}

async function runOnce(env: Env): Promise<{ processed: number; errors: number }> {
  const [emailCards, whatsappCards] = await Promise.all([
    getCardsInList(env, LISTS.inbox),
    getCardsInList(env, LISTS.whatsappInbox),
  ]);

  const queue: QueueItem[] = [
    ...emailCards.filter(isUnprocessed).map((card): QueueItem => ({ channel: "email", card })),
    ...whatsappCards.filter(isUnprocessed).map((card): QueueItem => ({ channel: "whatsapp", card })),
  ];

  const dailyLimit = Number(env.DAILY_TICKET_LIMIT || "20");
  let dailyCount = await getDailyCount(env);

  let processed = 0;
  let errors = 0;

  for (const { channel, card } of queue) {
    try {
      if (dailyCount >= dailyLimit) {
        await escalateForDailyLimit(env, card, dailyLimit, channel === "email" ? LISTS.escalated : LISTS.backlog);
      } else if (channel === "email") {
        await processCard(env, card);
        dailyCount = await incrementDailyCount(env);
      } else {
        await processWhatsAppCard(env, card);
        dailyCount = await incrementDailyCount(env);
      }
      processed++;
    } catch (err) {
      errors++;
      console.error(`Fehler bei Karte ${card.id} (${card.name}):`, err);
      await addCommentToCard(
        env,
        card.id,
        `⚠️ Viridis: Fehler bei der automatischen Verarbeitung — ${(err as Error).message}. Wird beim nächsten Lauf erneut versucht, oder bitte manuell prüfen.`
      ).catch(() => {});
    }
  }

  return { processed, errors };
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === DIGEST_CRON) {
      ctx.waitUntil(
        sendDailyDigest(env).catch((err) => {
          console.error("Fehler beim Versand der Tageszusammenfassung:", err);
        })
      );
      return;
    }

    ctx.waitUntil(
      runOnce(env).then((result) => {
        console.log(`Viridis-Lauf abgeschlossen: ${result.processed} verarbeitet, ${result.errors} Fehler.`);
      })
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.searchParams.get("digest") === "1") {
      await sendDailyDigest(env);
      return new Response(JSON.stringify({ digestSent: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await runOnce(env);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  },
};