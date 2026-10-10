# Brief de rédaction — pages conseils Sereina

Sereina est un espace d'écoute en ligne (France) où des accompagnants d'intelligence artificielle répondent aux personnes qui vont mal. Les pages conseils sont gratuites et servent le référencement naturel. Public : adultes de 30 à 70 ans et plus, souvent peu familiers du vocabulaire psy.

## Format de fichier

Un fichier Markdown par article dans `content/<theme>/<slug>.md`, avec un en-tête YAML :

```
---
title: "Titre SEO, 50 à 65 caractères, contient le mot-clé"
description: "Méta-description, 140 à 155 caractères, phrase complète, donne envie, contient le mot-clé"
keyword: "mot-clé principal"
reading: 7
---
```

Puis le corps :

- Pas de `# H1` dans le corps (le générateur l'ajoute depuis `title`).
- Une introduction de 2 à 3 paragraphes qui nomme le problème avec les mots de la personne, dit ce que la page va apporter, et place le mot-clé dans les 100 premiers mots.
- 5 à 8 sections `## H2`, avec des `### H3` quand utile. Les H2 sont des phrases ou des questions réelles (« Pourquoi le réveil arrive toujours vers 3 h »), pas des étiquettes (« Causes »).
- Longueur : 1 300 à 1 800 mots. Pas moins de 1 200.
- Une section `## Questions fréquentes` avec 3 à 5 questions au format :
  ```
  **La question telle qu'on la tape dans Google ?**

  La réponse en 2 à 4 phrases.
  ```
- Une dernière section `## Quand demander de l'aide` (2 paragraphes) : quand consulter (médecin traitant, psychologue, psychiatre), et rappel que le 3114 (prévention du suicide, 24 h/24, gratuit) et le 15 existent en cas de danger. Pour les articles du thème « aide », adapter au sujet.
- Ne pas écrire d'appel à l'action vers Sereina : le gabarit l'ajoute.

## Ton et style

- Vouvoiement. Phrases courtes. Mots simples. Aucun anglicisme inutile, aucun emoji, aucune formule creuse (« il est important de noter que », « dans un monde où »). Aucun tiret cadratin pour les incises.
- On s'adresse à quelqu'un qui souffre : respect, aucune condescendance, aucune leçon de morale. On valide ce que la personne vit avant de proposer quoi que ce soit.
- Concret : des exemples de situations réelles (une femme de 58 ans, un homme qui vient de prendre sa retraite, un cadre à six mois d'un arrêt), des gestes précis, des phrases à dire.
- Listes à puces autorisées seulement pour des étapes ou des exercices ; le reste en paragraphes.
- Chaque article est autonome mais peut renvoyer à d'autres sujets de la liste fournie avec des liens relatifs de la forme `[texte](/conseils/<theme-slug>/<slug>/)` : 2 à 4 liens internes par article, placés naturellement dans le texte. Utiliser uniquement les slugs de la liste.

## Prudence (obligatoire)

- Jamais de diagnostic, jamais de nom de médicament à prendre ou de posologie, jamais de promesse de guérison. On peut expliquer qu'il existe des traitements et que c'est le médecin qui décide.
- Ne pas donner de chiffres précis (statistiques, tarifs, textes de loi) sauf si vous les avez vérifiés aujourd'hui par recherche web ; sinon rester qualitatif (« une part importante des adultes »). Les seuls numéros toujours valides : 3114, 15, 112, 3919, 3977.
- Les contenus sur le suicide ou les idées noires : ton calme, pas de description de méthodes, orienter vers le 3114 et les proches dès le début de l'article.
- Dire clairement, quand c'est pertinent, que la page informe et ne remplace pas une consultation.
