import type { Env, TrelloCard } from "./types";

const API_BASE = "https://api.trello.com/1";

function authQuery(env: Env): string {
  return `key=${encodeURIComponent(env.TRELLO_API_KEY)}&token=${encodeURIComponent(env.TRELLO_TOKEN)}`;
}

async function trelloFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API_BASE}${path}${sep}${authQuery(env)}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Trello API ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return res;
}

/** Alle offenen Karten in einer Liste (z. B. der Inbox-Liste). */
export async function getCardsInList(env: Env, listId: string): Promise<TrelloCard[]> {
  const res = await trelloFetch(
    env,
    `/lists/${listId}/cards?fields=id,name,desc,idList,labels,shortUrl`
  );
  return res.json();
}

/** Setzt Labels auf einer Karte (ersetzt keine bestehenden, fügt hinzu). */
export async function addLabelToCard(env: Env, cardId: string, labelId: string): Promise<void> {
  await trelloFetch(env, `/cards/${cardId}/idLabels`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `value=${encodeURIComponent(labelId)}`,
  });
}

/** Verschiebt eine Karte in eine andere Liste. */
export async function moveCardToList(env: Env, cardId: string, listId: string): Promise<void> {
  await trelloFetch(env, `/cards/${cardId}?idList=${encodeURIComponent(listId)}`, {
    method: "PUT",
  });
}

/** Fügt einen Kommentar zu einer Karte hinzu (z. B. Protokoll der gesendeten Antwort). */
export async function addCommentToCard(env: Env, cardId: string, text: string): Promise<void> {
  await trelloFetch(env, `/cards/${cardId}/actions/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `text=${encodeURIComponent(text)}`,
  });
}

/** Setzt ein Fälligkeitsdatum (SLA-Ziel) auf der Karte. */
export async function setCardDue(env: Env, cardId: string, dueIso: string): Promise<void> {
  await trelloFetch(env, `/cards/${cardId}?due=${encodeURIComponent(dueIso)}`, {
    method: "PUT",
  });
}

/**
 * Markiert eine Karte als "vollständig" (grünes Häkchen). Funktioniert seit
 * der entsprechenden Trello-Änderung auch ohne gesetztes Fälligkeitsdatum
 * (dueComplete=true allein reicht aus).
 */
export async function markCardComplete(env: Env, cardId: string): Promise<void> {
  await trelloFetch(env, `/cards/${cardId}?dueComplete=true`, {
    method: "PUT",
  });
}

/** Weist ein Mitglied einer Karte zu (für Eskalationen). */
export async function addMemberToCard(env: Env, cardId: string, memberId: string): Promise<void> {
  await trelloFetch(env, `/cards/${cardId}/idMembers`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `value=${encodeURIComponent(memberId)}`,
  });
}
