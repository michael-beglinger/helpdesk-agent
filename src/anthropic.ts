import type { Env } from "./types";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";

/**
 * Gemeinsamer Anthropic-Aufruf für classify.ts und reply.ts (E-Mail und
 * WhatsApp): POST an die Messages-API, Fehlerbehandlung und Extraktion des
 * ersten Text-Blocks aus der Antwort.
 */
export async function callClaude(
  env: Env,
  input: { system: string; userMessage: string; maxTokens: number; model?: string }
): Promise<string> {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: input.model ?? MODEL,
      max_tokens: input.maxTokens,
      // System-Prompts sind pro Aufrufer statisch und werden innerhalb eines
      // Laufs (mehrere Karten) sowie über aufeinanderfolgende Cron-Läufe
      // (alle 5 Minuten) wiederholt unverändert gesendet — Prompt-Caching
      // spart hier den Grossteil der Input-Tokens. Ephemeral-TTL (5 Min.
      // Default) passt zum Cron-Intervall.
      system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: input.userMessage }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock?.text) throw new Error("Keine Textantwort vom Modell erhalten.");
  return textBlock.text.trim();
}
