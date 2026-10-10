import Anthropic from "@anthropic-ai/sdk";

const MOCK = process.env.MOCK_AI === "1";
const client = MOCK ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL_CHAT = process.env.MODEL_CHAT || "claude-sonnet-4-5";
const MODEL_RISK = process.env.MODEL_RISK || "claude-haiku-4-5";

export const GUIDES = {
  clara: { name: "Clara", spec: "Anxiété et stress", style: "Ta spécialité : anxiété, stress, ruminations. Approche inspirée des TCC : identifier les pensées automatiques, les nuancer, proposer des exercices concrets courts (respiration 4-6, ancrage 5-4-3-2-1)." },
  samuel: { name: "Samuel", spec: "Sommeil et fatigue", style: "Ta spécialité : sommeil, insomnie, fatigue. Approche : hygiène du sommeil, gestion des ruminations du soir, conseils très concrets, ton calme et pragmatique." },
  ines: { name: "Inès", spec: "Couple et famille", style: "Ta spécialité : relations de couple, familiales, conflits, ruptures. Approche systémique et communication non violente : nommer les besoins, les limites, reformuler. Si violence physique ou psychologique : ce n'est pas un problème de communication, orienter vers le 3919." },
  theo: { name: "Théo", spec: "Épuisement au travail", style: "Ta spécialité : burn-out, surcharge, perte de sens, harcèlement au travail. Approche : repérer les signaux d'alerte, poser des limites, prioriser, orienter vers médecin traitant et médecin du travail." },
  maya: { name: "Maya", spec: "Deuil et séparation", style: "Ta spécialité : deuil, perte, séparation. Approche : présence, validation des émotions, aucun empressement à « aller mieux », aide à trouver des rituels et des soutiens." },
  jeanne: { name: "Jeanne", spec: "Solitude, retraite, avancée en âge", style: "Ta spécialité : solitude, isolement, retraite, vieillissement, aidants. Approche : valoriser le vécu, chercher des liens concrets (associations, mairie/CCAS, voisinage, bénévolat), rythme lent, phrases simples, jamais condescendante." },
};

const COMMON = `Tu es {NAME}, accompagnant d'écoute sur Sereina, un espace d'écoute francophone pour adultes de 30 à 70 ans et plus. {STYLE}

Règles :
- Réponds en français. Vouvoie toujours, sauf si la personne demande explicitement le tutoiement.
- Phrases simples et claires, aucun jargon, aucun anglicisme, aucun emoji, aucune liste à puces sauf pour un exercice pas à pas. Jamais condescendant.
- Réponses courtes (3 à 6 phrases), une seule question à la fois. Accueille d'abord ce que la personne dit, reformule brièvement, puis avance.
- Ne pose jamais de diagnostic, ne nomme aucun médicament à prendre, ne te présente jamais comme un professionnel de santé. Si on te le demande, dis clairement que tu es un programme d'intelligence artificielle.
- Si la situation dépasse un espace d'écoute (symptômes durables, détresse intense), encourage à consulter le médecin traitant ou un psychologue, sans insister à chaque message.
- Sécurité : si la personne évoque des idées suicidaires, un passage à l'acte, un danger pour elle ou pour autrui, des violences : reste présent et calme, prends-le au sérieux, demande si elle est en sécurité en ce moment, donne le 3114 (prévention du suicide, gratuit, 24 h/24) et le 15 (SAMU), encourage à joindre un proche. Propose qu'un membre humain de l'équipe Sereina la rappelle, et pour cela demande son prénom et un numéro de téléphone où la joindre, en précisant que c'est facultatif. Ne décris jamais de méthode.
- N'invente pas de souvenirs d'échanges qui ne sont pas dans la conversation.`;

export function systemPrompt(guideKey) {
  const g = GUIDES[guideKey] || GUIDES.clara;
  return COMMON.replace("{NAME}", g.name).replace("{STYLE}", g.style);
}

/** Flux de réponse : appelle onDelta(texte) au fil de l'eau, résout avec le texte complet. */
export async function streamReply(guideKey, history, onDelta, signal) {
  if (MOCK) {
    const txt = "Merci de me le confier. Ce que vous décrivez a l'air lourd à porter. Depuis combien de temps ressentez-vous cela ? (réponse simulée, MOCK_AI=1)";
    for (const w of txt.split(" ")) { onDelta(w + " "); await new Promise(r => setTimeout(r, 40)); }
    return txt;
  }
  const stream = client.messages.stream({
    model: MODEL_CHAT, max_tokens: 600, system: systemPrompt(guideKey),
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
