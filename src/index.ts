import {
  addCommentToCard,
  addLabelToCard,
  getCard,
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
import { checkReplySafety, ESCALATE_SENTINEL } from "./guard";
import {
  acquireCardLock,
  clearCardAttempts,
  getDailyCount,
  hasAlertedToday,
  incrementCardAttempts,
  incrementDailyCount,
  markAlertedToday,
  releaseCardLock,
} from "./ratelimit";
import {
  CATEGORY_LABELS,
  CUSTOMER_LABELS,
  DOMAIN_TO_CUSTOMER_LABEL,
  findCustomerLabelIdByName,
  KNOWN_SYSTEM_SENDER_DOMAINS,
  LISTS,
  URGENCY_LABELS,
} from "./config";
import type { Env, TrelloCard } from "./types";

const DIGEST_CRON = "0 16 * * *";

/** Konstantzeit-Vergleich, damit das Token nicht zeichenweise erraten werden kann. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

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
    senderVerified: email.senderVerified,
  });

  // Kunden-Label nur bei verifiziertem Absender: Eine Kundenadresse, die
  // lediglich irgendwo im Text steht, ist fälschbar (siehe parse.ts).
  const customerName =
    email.senderVerified && email.senderDomain ? DOMAIN_TO_CUSTOMER_LABEL[email.senderDomain] : undefined;
  const customerLabelId = customerName ? CUSTOMER_LABELS[customerName] : undefined;

  await addLabelToCard(env, card.id, CATEGORY_LABELS[classification.kategorie]);
  await addLabelToCard(env, card.id, URGENCY_LABELS[classification.dringlichkeit]);
  if (customerLabelId) await addLabelToCard(env, card.id, customerLabelId);

  if (!customerName) {
    const hint =
      email.senderDomain && !email.senderVerified
        ? `Absenderadresse "${email.senderEmail}" wurde nur im Text gefunden, nicht im Header-Block — unverifiziert, daher kein Kunden-Label gesetzt.`
        : `Absenderdomain "${email.senderDomain ?? "unbekannt"}" ist keinem Kunden-Label zugeordnet. Bitte Viridis_Domain_Label_Mapping ergänzen.`;
    await addCommentToCard(env, card.id, `⚠️ Viridis: ${hint}`);
  }

  // System-Benachrichtigung nur akzeptieren, wenn die Vendor-Domain aus dem
  // verifizierten Header stammt. Sonst könnte jede Mail, die "cloudflare.com"
  // im Text erwähnt, still im Backlog verschwinden statt eskaliert zu werden.
  const trustedSystemSender =
    email.senderVerified &&
    !!email.senderDomain &&
    KNOWN_SYSTEM_SENDER_DOMAINS.some((d) => email.senderDomain === d || email.senderDomain!.endsWith(`.${d}`));

  if (classification.ist_system_benachrichtigung && trustedSystemSender) {
    await addCommentToCard(
      env,
      card.id,
      `Viridis: als System-Benachrichtigung erkannt (${classification.begruendung}). Keine Kundenantwort, keine Eskalation.`
    );
    await moveCardToList(env, card.id, LISTS.backlog);
    return;
  }

  const threshold = Number(env.AUTOMATION_CONFIDENCE_THRESHOLD || "0.85");
  // Autoversand nur, wenn ALLE Bedingungen erfüllt sind:
  // - Standard-Kategorie mit ausreichender Konfidenz,
  // - kein Injection-Verdacht laut Klassifizierer,
  // - Absender aus dem verifizierten Header-Block UND bekannter Kunde.
  // Damit kann eine präparierte Mail keine Antwort an Dritte auslösen.
  const canAutomate =
    classification.kategorie === "Standard" &&
    classification.konfidenz >= threshold &&
    !classification.injection_verdacht &&
    email.senderVerified &&
    !!email.senderEmail &&
    !!customerName;

  let blockedReason: string | null = null;

  if (canAutomate && email.senderEmail) {
    const replyText = await generateStandardReply(env, {
      subject: email.subject,
      body: email.body,
    });

    const guard = checkReplySafety(replyText);
    if (!guard.ok) {
      blockedReason = guard.reason ?? "Antwort hat die Sicherheitsprüfung nicht bestanden.";
    } else {
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
  }

  const reasonParts: string[] = [];
  if (classification.injection_verdacht) {
    reasonParts.push("Injection-Verdacht: Der Text enthält Anweisungen an einen Assistenten oder Aufforderungen zu Links/Zahlungs-/Kontaktdaten — bitte mit besonderer Vorsicht prüfen.");
  }
  if (blockedReason) {
    reasonParts.push(`Automatische Antwort verworfen (${blockedReason}).`);
  }
  if (!email.senderEmail) {
    reasonParts.push("Keine Absenderadresse erkannt — bitte Kartenformat prüfen (siehe parse.ts).");
  } else if (!email.senderVerified) {
    reasonParts.push("Absenderadresse nicht aus dem Header-Block verifizierbar — kein Autoversand.");
  } else if (!customerName && classification.kategorie === "Standard") {
    reasonParts.push("Absenderdomain kein bekannter Kunde — kein Autoversand.");
  }
  if (classification.ist_system_benachrichtigung && !trustedSystemSender) {
    reasonParts.push("Als System-Benachrichtigung eingestuft, aber Absender nicht verifiziert — sicherheitshalber eskaliert statt ins Backlog.");
  }
  const reasonNote = reasonParts.length > 0 ? " " + reasonParts.join(" ") : "";
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
  const modelEscalated = replyText.trim().startsWith(ESCALATE_SENTINEL);

  const warning = classification.injection_verdacht || modelEscalated
    ? `⚠️ Injection-Verdacht: Die Nachricht enthält Anweisungen an einen Assistenten oder Aufforderungen zu Links/Zahlungs-/Kontaktdaten. Bitte mit besonderer Vorsicht prüfen.\n`
    : "";

  await addCommentToCard(
    env,
    card.id,
    modelEscalated
      ? `${warning}Viridis hat keinen Antwortvorschlag erstellt (Modell hat Eskalation angefordert).\nKategorie: ${classification.kategorie} · Dringlichkeit: ${classification.dringlichkeit} · Konfidenz: ${classification.konfidenz.toFixed(2)}`
      : `${warning}Viridis schlägt folgende Antwort vor (bitte manuell in WhatsApp Business einfügen):\nKategorie: ${classification.kategorie} · Dringlichkeit: ${classification.dringlichkeit} · Konfidenz: ${classification.konfidenz.toFixed(2)}\n\n${replyText}`
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

/**
 * Fehlerbehandlung nach einem gescheiterten Verarbeitungsversuch.
 *
 * Trägt die Karte bereits ein Kategorie-Label (der Fehler trat also NACH dem
 * Labeln auf, z. B. beim Antwortversand), gilt sie für isUnprocessed als
 * erledigt und käme nie wieder in die Queue — sie würde still in der Inbox
 * liegen bleiben. Solche Karten werden deshalb sofort eskaliert (Liste +
 * Slack). Karten ohne Label werden beim nächsten Lauf erneut versucht,
 * begrenzt durch MAX_CARD_ATTEMPTS.
 */
async function handleProcessingFailure(
  env: Env,
  card: TrelloCard,
  targetList: string,
  maxAttempts: number
): Promise<void> {
  let alreadyLabelled = false;
  try {
    alreadyLabelled = !isUnprocessed(await getCard(env, card.id));
  } catch (err) {
    console.error(`Kartenstatus nach Fehler nicht abrufbar (${card.id}):`, err);
  }

  if (!alreadyLabelled) {
    await addCommentToCard(
      env,
      card.id,
      `⚠️ Viridis: Fehler bei der automatischen Verarbeitung. Wird beim nächsten Lauf erneut versucht (max. ${maxAttempts} Versuche). Details im Worker-Log.`
    ).catch(() => {});
    return;
  }

  await addCommentToCard(
    env,
    card.id,
    `⚠️ Viridis: Fehler nach der Klassifizierung (z. B. beim Antwortversand). Karte wird ans Team eskaliert, damit sie nicht liegen bleibt. Bitte prüfen, ob bereits eine Antwort an den Kunden gegangen ist. Details im Worker-Log.`
  ).catch(() => {});
  await moveCardToList(env, card.id, targetList).catch((e) =>
    console.error(`Eskalation nach Fehler fehlgeschlagen (${card.id}):`, e)
  );
  await clearCardAttempts(env, card.id).catch(() => {});

  try {
    await notifySlackEscalation(env, {
      cardName: card.name,
      cardUrl: card.shortUrl,
      kategorie: "—",
      dringlichkeit: "—",
      begruendung: "Verarbeitungsfehler nach der Klassifizierung — Karte wurde ans Team eskaliert, bitte manuell prüfen.",
    });
  } catch (e) {
    console.error(`Slack-Benachrichtigung (Fehler-Eskalation) fehlgeschlagen für Karte ${card.id}:`, e);
  }
  try {
    await logTicket(env, { cardName: card.name, cardUrl: card.shortUrl, status: "eskaliert" });
  } catch (e) {
    console.error(`Digest-Protokollierung fehlgeschlagen für Karte ${card.id}:`, e);
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
  const maxAttempts = Number(env.MAX_CARD_ATTEMPTS || "3");
  const lockTtlSeconds = Number(env.CARD_LOCK_TTL_SECONDS || "300");
  let dailyCount = await getDailyCount(env);

  let processed = 0;
  let errors = 0;

  for (const { channel, card } of queue) {
    const targetList = channel === "email" ? LISTS.escalated : LISTS.backlog;

    // Pro-Karte-Lock: schützt vor doppelter Verarbeitung, falls sich zwei
    // Läufe überlappen (höhere Cron-Frequenz oder ein Lauf, der bei hohem
    // Ticketvolumen länger dauert als das Cron-Intervall). Siehe
    // acquireCardLock in ratelimit.ts für Details/Grenzen.
    if (!(await acquireCardLock(env, card.id, lockTtlSeconds))) {
      console.log(`Karte ${card.id} übersprungen: bereits durch einen anderen Lauf gesperrt.`);
      continue;
    }

    try {
      if (dailyCount >= dailyLimit) {
        await escalateForDailyLimit(env, card, dailyLimit, targetList);
        processed++;
        continue;
      }

      // Fehlversuche begrenzen: Eine Karte, die wiederholt scheitert,
      // darf nicht unbegrenzt bezahlte API-Aufrufe erzeugen.
      const attempts = await incrementCardAttempts(env, card.id);
      if (attempts > maxAttempts) {
        await addCommentToCard(
          env,
          card.id,
          `⚠️ Viridis: Verarbeitung ist ${attempts - 1}-mal fehlgeschlagen. Karte wird ohne KI-Ergebnis ans Team eskaliert.`
        );
        await moveCardToList(env, card.id, targetList);
        await clearCardAttempts(env, card.id);
        processed++;
        continue;
      }

      // Tageszähler VOR dem Modellaufruf erhöhen, damit auch fehlgeschlagene
      // Aufrufe gegen das Limit zählen.
      dailyCount = await incrementDailyCount(env);

      if (channel === "email") {
        await processCard(env, card);
      } else {
        await processWhatsAppCard(env, card);
      }
      await clearCardAttempts(env, card.id);
      processed++;
    } catch (err) {
      errors++;
      // Details nur ins Log: Fehlertexte der APIs können Kundentext oder
      // interne Angaben enthalten und gehören nicht in den Trello-Kommentar.
      console.error(`Fehler bei Karte ${card.id} (${card.name}):`, err);
      await handleProcessingFailure(env, card, targetList, maxAttempts);
    } finally {
      await releaseCardLock(env, card.id).catch((err) =>
        console.error(`Lock-Freigabe fehlgeschlagen für Karte ${card.id}:`, err)
      );
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

  /**
   * Manueller Trigger (lokales Testen, Digest-Test). Ohne gesetztes
   * ADMIN_TOKEN-Secret ist der Handler deaktiviert; mit Secret wird der
   * Header "X-Viridis-Token" geprüft. Andernfalls könnte jeder mit der
   * Worker-URL Läufe auslösen (Tageslimit aufbrauchen) oder per ?digest=1
   * das Digest verschicken und das Protokoll löschen.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ADMIN_TOKEN) {
      return new Response("Not found", { status: 404 });
    }
    const provided = request.headers.get("X-Viridis-Token") ?? "";
    if (!timingSafeEqual(provided, env.ADMIN_TOKEN)) {
      return new Response("Unauthorized", { status: 401 });
    }

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