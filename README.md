# Sereina — site, chat, paywall et back-office

Tout est prêt à déployer sur un serveur (Linux, Node 20+). Aucune base de données externe : SQLite dans `server/data/`.

## Contenu du dossier

- `content/` : les 100 articles conseils en Markdown (8 thèmes), modifiables à la main.
- `topics.json` : la liste des sujets, thèmes et accompagnants.
- `build.py` : génère le site statique dans `dist/` (`python3 build.py --site-url https://www.votre-domaine.fr`).
- `dist/` : le site généré (112 URL, sitemap.xml, robots.txt). C'est ce que le serveur sert.
- `server/` : le serveur Node (chat IA, paywall Stripe, score de risque, back-office).
- `BRIEF.md` : la charte de rédaction, à réutiliser pour les prochains articles.

## Mise en route (10 minutes)

```bash
# 1. Générer le site avec votre domaine (nécessaire pour les URL canoniques et le sitemap)
pip install markdown pyyaml
python3 build.py --site-url https://www.votre-domaine.fr

# 2. Serveur
cd server
cp .env.example .env     # remplir : ANTHROPIC_API_KEY, STRIPE_*, ADMIN_EMAIL/ADMIN_PASSWORD, TOTP_ENCRYPTION_KEY, SITE_URL, COOKIE_SECRET, un canal d'alerte
npm install
npm start                # écoute sur le port 3000
```

Mettez un reverse proxy (nginx, Caddy) devant avec HTTPS. Exemple Caddy, deux lignes :

```
www.votre-domaine.fr {
  reverse_proxy localhost:3000
}
```

Pour tester sans clé ni carte : `MOCK_AI=1 npm start` (réponses simulées, classification par mots-clés).

## Ce que fait le serveur

**Chat** (`POST /api/chat`) : exige le consentement (`POST /api/consent`), identifie le visiteur par un cookie signé (pas de compte à créer), garde l'historique par accompagnant, répond en flux (SSE) avec Claude. Chaque accompagnant a ses consignes dans `server/ai.js` (`GUIDES`, `COMMON`).

**Crédits** : les premiers échanges sont gratuits (`FREE_MINUTES` ou `FREE_MESSAGES`, le premier seuil atteint). Ensuite, 1 crédit = 1 message envoyé. Trois packs définis dans `PACKS` (clé:crédits:centimes:libellé), achetés en paiement unique par Stripe Checkout, carte enregistrée. À l'achat, la recharge automatique est cochée par défaut : quand les crédits tombent à zéro, le serveur rachète le même pack hors session avec la carte enregistrée (`autoRecharge` dans `server.js`) et la conversation continue sans interruption ; si le paiement échoue (carte expirée, authentification requise), l'option est désactivée et la fenêtre d'achat réapparaît. L'utilisateur active ou désactive la recharge dans « Mon compte ». Le webhook Stripe (`checkout.session.completed`, et `payment_intent.succeeded` en filet de sécurité) crédite le compte. Le back-office permet d'offrir des crédits.

Dans Stripe : aucune configuration de produit n'est nécessaire (les packs sont créés à la volée) ; déclarer seulement un endpoint webhook `https://www.votre-domaine.fr/api/stripe/webhook` avec les événements `checkout.session.completed` et `payment_intent.succeeded` → `STRIPE_WEBHOOK_SECRET`.

**Score de risque (vert → rouge)** : à chaque message, un second modèle (rapide, peu coûteux) classe les 5 derniers messages de la personne :

| Niveau | Sens | Ce qui se passe |
|---|---|---|
| vert | mal-être ordinaire | rien |
| jaune | détresse marquée, désespoir, sans idée de mort | visible dans le back-office |
| orange | idées de mort ou suicidaires passives, automutilation, violences subies | alerte créée + e-mail/webhook à l'équipe |
| rouge | intention, plan, moyen, geste en cours, danger immédiat | alerte + e-mail/webhook/SMS, protocole rouge affiché dans la fiche, bandeau 3114/15 côté utilisateur, l'accompagnant demande prénom et téléphone pour un rappel humain |

Le niveau d'un utilisateur ne redescend pas tout seul tant qu'une alerte n'a pas été marquée « prise en charge » par un humain.

**Back-office** (`/admin/`) : liste des utilisateurs triée par risque non traité (rouge, orange, jaune) puis activité, compteurs, page « Alertes ouvertes », fiche par utilisateur avec la conversation complète, le niveau de chaque message, les coordonnées connues, les achats, un bouton pour offrir des crédits et le formulaire « Marquer comme pris en charge ». Rafraîchissement automatique toutes les 30 secondes.

## Sécurité du back-office

La logique est reprise du back-office renta-immo (PBKDF2, verrouillage progressif, TOTP chiffré, sessions invalidées au changement de mot de passe, CSRF par Origin, journal d'audit, limitation à fenêtre glissante, en-têtes de sécurité), réécrite pour Node/Express et SQLite dans `server/security/`.

- **Comptes** : au premier démarrage, `ADMIN_EMAIL` / `ADMIN_PASSWORD` créent le compte propriétaire, qui doit changer son mot de passe à la première connexion. Le propriétaire crée ensuite les autres membres dans « Équipe » avec un mot de passe provisoire (changement obligatoire à la première connexion).
- **Rôles** : propriétaire (tout, y compris l'équipe), administrateur (tout sauf l'équipe), astreinte (utilisateurs, alertes, prise en charge ; pas de crédits offerts, pas de journal).
- **Mots de passe** : PBKDF2-SHA512 310 000 itérations, 12 caractères minimum avec majuscule, minuscule et chiffre, calcul factice pour les comptes inconnus.
- **Verrouillage** : 5 échecs → 15 min, puis 30, 60, 120 min ; plus 10 tentatives maximum par IP et e-mail par quart d'heure. Le propriétaire déverrouille depuis « Équipe ».
- **Double authentification** : TOTP (Google Authenticator, Authy, 1Password…), secret chiffré AES-256-GCM avec `TOTP_ENCRYPTION_KEY`, 8 codes de récupération à usage unique, 8 essais de code par session. À activer par chaque membre dans « Mon compte » ; fortement conseillé pour tous.
- **Sessions** : cookie `__Host-` httpOnly, Secure, SameSite strict, 7 jours, révocables depuis « Mon compte », toutes fermées au changement de mot de passe ou à la désactivation d'un membre.
- **CSRF** : contrôle de l'en-tête Origin sur toute requête qui modifie l'état (site et back-office), plus un jeton par session dans chaque formulaire du back-office.
- **Journal d'audit** (`/admin/journal`) : connexions, échecs, verrouillages, 2FA, consultations de fiches, prises en charge, crédits offerts, gestion de l'équipe, avec IP.
- **En-têtes** : CSP (`script-src 'self'`, aucun script en ligne), HSTS en HTTPS, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, COOP/CORP ; corps limités à 32 Ko (API) et 64 Ko (formulaires).
- **Limitation de débit** : chat 20 messages / 5 min, contact 5 / h, achat 10 / h, connexion 10 / 15 min ; champ piège (honeypot) sur le formulaire de contact.
- **Alertes** : e-mail, webhook Slack/Discord/Teams, SMS Twilio (rouge) et Telegram, avec anti-spam de 6 h par utilisateur et niveau sur Telegram.

## Prompts des accompagnants

Chaque message envoyé au modèle contient, dans l'ordre : les **règles communes** (`server/prompts/_commun.md` : ton, limites, protocole de sécurité), le **prompt de l'accompagnant** (`server/prompts/<prenom>.md` : personnalité, ce qu'il accompagne, méthode, points d'attention), puis les **indications** éventuelles saisies par l'équipe.

Deux façons de les modifier :

- **Depuis le back-office**, page « Accompagnants » (rôle administrateur ou propriétaire) : modifier le prompt, ajouter des indications sans réécrire le prompt, **tester** avec un message (sans consommer de crédits), voir le prompt complet réellement envoyé, revenir au prompt par défaut ou restaurer une version précédente. Les changements sont actifs dès le message suivant, sans redémarrage, et tracés dans le journal d'audit. Les règles communes ne peuvent pas être enregistrées sans le protocole de sécurité (3114).
- **Dans les fichiers** `server/prompts/*.md` : ce sont les versions par défaut, versionnées dans Git. Une modification faite dans le back-office prime sur le fichier tant qu'on ne revient pas au défaut.

Pour ajouter un accompagnant : créer `server/prompts/<cle>.md` (avec `nom` et `specialite` en en-tête), puis l'ajouter dans `PROFILES` de `build.py` et dans la liste `GUIDES` de `static/chat.js`, ajouter son portrait, et relancer `build.py`.

## Exploitation

- **Santé** : `GET /api/health` répond `{ok:true}` (503 pendant un redéploiement) pour la surveillance externe (UptimeRobot, Better Stack…). `GET /api/health?details=1` avec un admin connecté ou `Authorization: Bearer HEALTH_SECRET` donne l'état de l'IA, de Stripe, de l'e-mail, de la file d'e-mails, des alertes ouvertes et des conversations en cours.
- **File d'e-mails** : les alertes et les messages de contact sont écrits en base puis envoyés ; en cas d'échec SMTP, nouvel essai après 1, 5 et 30 min, puis statut FAILED visible dans `/api/health?details=1`. Rien n'est perdu si le serveur de mail est indisponible quelques minutes.
- **Arrêt propre** : sur SIGTERM (redéploiement, `systemctl restart`), le serveur refuse les nouveaux chats, laisse finir les réponses en cours (`SHUTDOWN_DRAIN_MS`, 15 s par défaut), puis ferme la base.
- **Maillage automatique** : `build.py` ajoute jusqu'à 6 liens internes par article à partir des mots-clés et alias de `topics.json` (champ `aliases`, séparés par `|`), hors titres, FAQ et liens existants. Pour renforcer un article, ajoutez-lui des alias.

## Le cas rouge : pourquoi un humain, et pas un appel automatique

Il n'existe pas d'interface pour qu'un logiciel appelle le SAMU : le 15 et le 3114 sont des lignes vocales où un régulateur pose des questions (lieu, état, identité). Un appel automatique basé sur une classification par IA produirait des fausses alertes (le classificateur se trompe, par exemple sur une personne qui raconte le passé) et engagerait la responsabilité de l'entreprise. Le dispositif prévu est donc : détection automatique en quelques secondes, alerte immédiate à une personne d'astreinte (e-mail, Slack/Discord, SMS), protocole clair dans la fiche (rappeler la personne si un numéro est connu, appeler le 15 soi-même en transmettant les éléments si danger immédiat), et traçabilité de ce qui a été fait. Côté utilisateur, le 3114 et le 15 sont affichés immédiatement.

Pour que cela fonctionne, il faut une astreinte humaine joignable (même une seule personne avec le téléphone) et un canal d'alerte configuré dans `.env`. Sans canal, les alertes restent visibles dans le back-office mais personne n'est prévenu.

## Portraits des accompagnants

Déposez vos six images dans `static/img/accompagnants/` sous les noms `clara.jpg`, `samuel.jpg`, `ines.jpg`, `theo.jpg`, `maya.jpg`, `jeanne.jpg` (carré, 600 × 600 px minimum), puis relancez `python3 build.py`. Pour du .png ou du .webp : `PORTRAIT_EXT=webp python3 build.py`. Tant qu'un fichier manque, un visuel provisoire avec l'initiale est affiché. Les portraits apparaissent sur l'accueil, la page et la fiche de chaque accompagnant (`/accompagnants/<prenom>/`), dans l'en-tête du chat et dans les encarts des articles. Le site précise à chaque fois que ce sont des illustrations et que les accompagnants ne sont pas des personnes réelles : conservez cette mention, surtout si vos images sont réalistes.

## Pages et fenêtres

- `/accompagnants/` et `/accompagnants/<prenom>/` : présentation de chaque accompagnant (façon d'écouter, situations, ce qu'il n'est pas, articles liés), avec portrait.

- `/parler/` : fenêtre de consentement avant le premier message (18 ans, traitement des données ; enregistrée côté serveur, le chat refuse sans), fenêtre d'achat de crédits quand la période gratuite est finie (packs depuis `PACKS`, case de recharge automatique cochée), bouton « Arrêter la réponse », « Recommencer », indicateur d'essai gratuit.
- `/credits/` : page tarifs (essai gratuit et packs de crédits) avec questions fréquentes ; `/abonnement/` redirige vers elle.
- `/mon-compte/` : crédits restants, historique des achats, case de recharge automatique, accès à la carte enregistrée et aux reçus (portail Stripe), suppression de toutes les données avec confirmation.
- `/contact/` : formulaire envoyé par e-mail à `CONTACT_EMAIL` (sinon `ALERT_EMAIL`), via le SMTP configuré.
- `/a-propos/`, `/confidentialite/`, `/cgv/`, `/mentions-legales/` : textes rédigés, avec des crochets `[...]` uniquement pour l'identité de la société, le DPO et le médiateur.

## Déploiement

Trois façons, au choix :

1. **Script** sur un serveur Debian/Ubuntu neuf (installe Node, Caddy avec HTTPS automatique, le service systemd) : `sudo bash deploy/install.sh www.votre-domaine.fr`, puis remplir `/opt/sereina/server/.env` et `systemctl restart sereina`.
2. **Docker** : remplir `server/.env`, modifier le domaine dans `docker-compose.yml`, puis `docker compose up -d --build`. Mettre Caddy ou nginx devant (`deploy/Caddyfile`).
3. **À la main** : `python3 build.py --site-url ...`, `cd server && npm install && npm start`, et `deploy/Caddyfile` + `deploy/sereina.service` comme modèles.

Pour changer les packs : la même variable `PACKS` dans `.env` (serveur) et au moment du `build.py` (pages), par exemple `PACKS="petit:20:490:Petit pack,..." python3 build.py`.

## Points à traiter avant l'ouverture au public

- **Mentions légales et RGPD** : les pages confidentialité, CGV et mentions légales sont rédigées ; compléter les crochets `[...]` (société, adresse, DPO, médiateur) et faire valider. Les conversations sont des données de santé au sens du RGPD : base légale, information claire de l'utilisateur, durée de conservation (`RETENTION_DAYS`, 90 jours par défaut, purge automatique), droit de suppression (`POST /api/me/delete` existe), hébergement en Europe, analyse d'impact (AIPD) probablement requise. Faire valider par un avocat ou un DPO.
- **Hébergement de données de santé** : selon la qualification du service, un hébergeur certifié HDS peut être exigé en France. À vérifier avec un conseil.
- **Astreinte** : qui reçoit les alertes, à quelles heures, que fait-on la nuit.
- **Analytics** : aucun outil de mesure n'est installé (pas de cookie tiers). Ajouter Plausible, Matomo ou la Search Console selon vos besoins.
- **Nouveaux articles** : ajouter un fichier dans `content/<theme>/` et une ligne dans `topics.json`, puis relancer `build.py`.

## Structure des URL

```
/                                   accueil
/conseils/                          index des 8 thèmes
/conseils/<theme>/                  page thème (liste des articles)
/conseils/<theme>/<article>/        article (balisage Article, FAQPage, BreadcrumbList)
/parler/                            chat
/urgence/                           numéros d'urgence
/mentions-legales/
/sitemap.xml  /robots.txt
/api/...  /admin/...                serveur (exclus de l'indexation)
```
