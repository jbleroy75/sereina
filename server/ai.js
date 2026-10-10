import Anthropic from "@anthropic-ai/sdk";

const MOCK = process.env.MOCK_AI === "1";
const client = MOCK ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL_CHAT = process.env.MODEL_CHAT || "claude-sonnet-4-5";
const MODEL_RISK = process.env.MODEL_RISK || "claude-haiku-4-5";

import { listGuides, systemPrompt } from "./prompts.js";
export { systemPrompt };

// Accompagnants lus depuis server/prompts/*.md (nom, spécialité).
export const GUIDES = Object.fromEntries(listGuides().map(g => [g.key, g]));

/** Flux de réponse : appelle onDelta(texte) au fil de l'eau, résout avec le texte complet. */
export async function streamReply(guideKey, history, onDelta, signal, systemOverride) {
  if (MOCK) {
    const txt = "Merci de me le confier. Ce que vous décrivez a l'air lourd à porter. Depuis combien de temps ressentez-vous cela ? (réponse simulée, MOCK_AI=1)";
    for (const w of txt.split(" ")) { onDelta(w + " "); await new Promise(r => setTimeout(r, 40)); }
    return txt;
  }
  const stream = client.messages.stream({
    model: MODEL_CHAT, max_tokens: 600, system: systemOverride || systemPrompt(guideKey),
    messages: history,
  }, { signal });
  let full = "";
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { full += ev.delta.text; onDelta(ev.delta.text); }
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

export async function assessRisk(recentUserMessages) {
  const text = recentUserMessages.map((m, i) => `[${i + 1}] ${m}`).join("\n");
  if (MOCK) {
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
