import {
  addCommentToCard,
  addLabelToCard,
  getCardsInList,
  markCardComplete,
  moveCardToList,
} from "./trello";
import { classifyEmail } from "./classify";
import { generateStandardReply } from "./reply";
import { sendEmail } from "./email";
import { extractEmailFromCard } from "./parse";
import { notifySlackEscalation } from "./slack";
import { logTicket, sendDailyDigest } from "./digest";
import {
  CATEGORY_LABELS,
  CUSTOMER_LABELS,
  DOMAIN_TO_CUSTOMER_LABEL,
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

async function runOnce(env: Env): Promise<{ processed: number; errors: number }> {
  const cards = await getCardsInList(env, LISTS.inbox);
  const unprocessed = cards.filter(isUnprocessed);

  let processed = 0;
  let errors = 0;

  for (const card of unprocessed) {
    try {
      await processCard(env, card);
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