import Anthropic from "@anthropic-ai/sdk";
import { recordUsage, estimateTokens } from "./costs.js";

const MOCK = process.env.MOCK_AI === "1";
const client = MOCK ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Modèles actuels au 11/10/2026 (platform.claude.com/docs/en/about-claude/models/overview).
export const MODEL_CHAT = process.env.MODEL_CHAT || "claude-sonnet-5-5";
export const MODEL_RISK = process.env.MODEL_RISK || "claude-haiku-5-5";

import { listGuides, systemPrompt } from "./prompts.js";
export { systemPrompt };

// Accompagnants lus depuis server/prompts/*.md (nom, spécialité).
export const GUIDES = Object.fromEntries(listGuides().map(g => [g.key, g]));

/** Flux de réponse : appelle onDelta(texte) au fil de l'eau, résout avec le texte complet. */
// meta = { userId, kind: "chat" | "test", billable }
export async function streamReply(guideKey, history, onDelta, signal, systemOverride, meta = {}) {
  const system = systemOverride || systemPrompt(guideKey);
  if (MOCK) {
    const txt = "Merci de me le confier. Ce que vous décrivez a l'air lourd à porter. Depuis combien de temps ressentez-vous cela ? (réponse simulée, MOCK_AI=1)";
    for (const w of txt.split(" ")) { onDelta(w + " "); await new Promise(r => setTimeout(r, 40)); }
    recordUsage({ userId: meta.userId, kind: meta.kind || "chat", guide: guideKey, model: MODEL_CHAT, mock: true, billable: meta.billable,
      usage: { input_tokens: estimateTokens(system) + estimateTokens(history.map(m => m.content).join(" ")), output_tokens: estimateTokens(txt) } });
    return txt;
  }
  // Le prompt système (règles communes + accompagnant) est identique d'un message à l'autre : on le met en cache
  // pour ne payer qu'une fraction du prix d'entrée sur les messages suivants.
  const stream = client.messages.stream({
    model: MODEL_CHAT, max_tokens: 600,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: history,
  }, { signal });
  let full = "";
  try {
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { full += ev.delta.text; onDelta(ev.delta.text); }
    }
  } finally {
    // Les jetons consommés sont facturés même si la personne interrompt la réponse : on enregistre toujours.
    try { const fin = await stream.finalMessage(); recordUsage({ userId: meta.userId, kind: meta.kind || "chat", guide: guideKey, model: fin.model || MODEL_CHAT, usage: fin.usage, billable: meta.billable }); }
    catch { recordUsage({ userId: meta.userId, kind: meta.kind || "chat", guide: guideKey, model: MODEL_CHAT, billable: meta.billable,
      usage: { input_tokens: estimateTokens(system) + estimateTokens(history.map(m => m.content).join(" ")), output_tokens: estimateTokens(full) } }); }
  }
  return full;
}

const RISK_PROMPT = `Tu es un classificateur de risque pour un espace d'écoute en santé mentale (France). On te donne les derniers messages d'une personne. Évalue le risque IMMÉDIAT pour sa sécurité ou celle d'autrui et réponds UNIQUEMENT par un JSON : {"level": 0|1|2|3, "reason": "une phrase courte en français", "first_name": string|null, "phone": string|null, "city": string|null}.

Niveaux :
0 = vert : mal-être ordinaire, stress, tristesse, fatigue, conflit, sans danger.
1 = jaune : détresse marquée, désespoir, « je n'en peux plus », isolement fort, mais aucune idée de mort ni de violence.
2 = orange : idées de mort ou idées suicidaires passives (« je préférerais ne plus être là »), automutilation évoquée, violence subie, consommation inquiétante, sans plan ni intention immédiate.
3 = rouge : intention suicidaire exprimée, plan, moyen ou date, passage à l'acte en cours ou imminent, prise de médicaments ou geste déjà fait, menace envers autrui, personne en danger physique immédiat.

Extrais first_name, phone, city seulement si la personne les a donnés elle-même. En cas de doute entre deux niveaux, prends le plus élevé.`;

export async function assessRisk(recentUserMessages, meta = {}) {
  const text = recentUserMessages.map((m, i) => `[${i + 1}] ${m}`).join("\n");
  if (MOCK) {
    recordUsage({ userId: meta.userId, kind: "risk", model: MODEL_RISK, mock: true, usage: { input_tokens: estimateTokens(RISK_PROMPT + text), output_tokens: 40 } });
    const t = text.toLowerCase();
    const level = /suicid|me tuer|en finir|médicaments|plan/.test(t) ? 3 : /mourir|plus envie de vivre|me faire du mal/.test(t) ? 2 : /n'en peux plus|désespoir|seul/.test(t) ? 1 : 0;
    const phone = (text.match(/0[1-9](?:[ .-]?\d{2}){4}/) || [null])[0];
    return { level, reason: "classification simulée (MOCK_AI=1)", first_name: null, phone, city: null };
  }
  try {
    const r = await client.messages.create({
      model: MODEL_RISK, max_tokens: 200, system: RISK_PROMPT,
      messages: [{ role: "user", content: text }],
    });
    recordUsage({ userId: meta.userId, kind: "risk", model: r.model || MODEL_RISK, usage: r.usage });
    const raw = r.content.map(c => c.text || "").join("");
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw);
    const level = Math.max(0, Math.min(3, Number(j.level) || 0));
    return { level, reason: String(j.reason || ""), first_name: j.first_name || null, phone: j.phone || null, city: j.city || null };
  } catch (e) {
    console.error("assessRisk failed", e.message);
    // En cas d'échec du classificateur, filet de sécurité par mots-clés
    const t = text.toLowerCase();
    const level = /suicid|me tuer|en finir|mettre fin/.test(t) ? 3 : /mourir|plus envie de vivre|me faire du mal/.test(t) ? 2 : 0;
    return { level, reason: level ? "mots-clés (classificateur indisponible)" : "", first_name: null, phone: null, city: null };
  }
}
