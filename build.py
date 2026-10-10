#!/usr/bin/env python3
"""Génère le site statique Sereina dans dist/ à partir de content/ et topics.json.
Usage : python3 build.py [--site-url https://www.exemple.fr]
"""
import json, os, re, shutil, sys, html, datetime
import markdown, yaml

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE_URL = "https://www.sereina.fr"
for i, a in enumerate(sys.argv):
    if a == "--site-url" and i + 1 < len(sys.argv):
        SITE_URL = sys.argv[i + 1].rstrip("/")
DIST = os.path.join(ROOT, "dist")
TODAY = datetime.date.today().isoformat()
PACKS = [dict(zip(("key", "credits", "cents", "label"), p.split(":"))) for p in os.environ.get("PACKS", "petit:20:490:Petit pack,moyen:60:1290:Pack confort,grand:150:2490:Grand pack").split(",")]
for _p in PACKS:
    _p["credits"] = int(_p["credits"]); _p["cents"] = int(_p["cents"]); _p["price"] = f"{_p['cents']//100},{_p['cents']%100:02d} €"
DEFAULT_PACK = os.environ.get("DEFAULT_PACK", PACKS[1]["key"] if len(PACKS) > 1 else PACKS[0]["key"])
PRICE_LABEL = f"à partir de {PACKS[0]['price']}"
FREE_MINUTES = os.environ.get("FREE_MINUTES", "5")
FREE_MESSAGES = os.environ.get("FREE_MESSAGES", "8")
RETENTION_DAYS = os.environ.get("RETENTION_DAYS", "90")

topics = json.load(open(os.path.join(ROOT, "topics.json")))
THEMES = topics["themes"]
ARTICLES = topics["articles"]
by_theme = {}
for a in ARTICLES:
    by_theme.setdefault(a["theme"], []).append(a)

PORTRAIT_EXT = os.environ.get("PORTRAIT_EXT", "jpg")
PROFILES = {
    "clara": {"name": "Clara", "spec": "Anxiété et stress", "theme": "anxiete",
        "short": "Pour les pensées qui tournent en boucle, l'inquiétude permanente, le stress du quotidien.",
        "approach": "Clara travaille de façon structurée, inspirée des thérapies cognitives et comportementales. Elle aide d'abord à nommer ce qui se passe dans le corps et dans la tête, puis à repérer les pensées automatiques qui entretiennent l'inquiétude, et à les nuancer. Elle propose des exercices courts, faisables n'importe où : respiration lente, ancrage par les sens, décentration.",
        "for": ["Crises d'angoisse et peur qu'elles reviennent", "Inquiétude permanente, ruminations, difficulté à décrocher", "Stress du quotidien qui déborde sur le sommeil et le corps", "Anxiété sociale, peur du jugement, anxiété de performance"],
        "tone": "Douce, précise, concrète. Une question à la fois."},
    "samuel": {"name": "Samuel", "spec": "Sommeil et fatigue", "theme": "sommeil",
        "short": "Pour les nuits courtes, les réveils à 3 heures, la fatigue qui ne part pas.",
        "approach": "Samuel s'appuie sur les principes de l'hygiène du sommeil et de la thérapie comportementale de l'insomnie. Il commence par comprendre vos nuits telles qu'elles sont, sans jugement, puis travaille sur les routines du soir, la gestion des réveils nocturnes et la charge mentale qui empêche de s'endormir. Il ne promet pas des nuits parfaites, mais des nuits meilleures, par petites étapes.",
        "for": ["Difficulté à s'endormir, réveils nocturnes, réveil trop tôt", "Fatigue qui s'installe malgré le repos", "Sommeil perturbé par le stress, la ménopause, l'âge", "Dépendance aux somnifères et envie d'en parler avec son médecin"],
        "tone": "Calme, pragmatique, patient."},
    "ines": {"name": "Inès", "spec": "Couple et famille", "theme": "couple",
        "short": "Pour les disputes qui reviennent, les silences, les ruptures, les relations avec les enfants ou les parents.",
        "approach": "Inès écoute les relations comme un système : ce qui se répète, ce que chacun attend sans le dire, les besoins qui n'ont pas trouvé de mots. Elle s'appuie sur la communication non violente pour aider à formuler ce qui blesse et ce dont on a besoin, sans accuser. Elle sait aussi dire quand une situation n'est plus un problème de communication mais de violence, et vers qui se tourner.",
        "for": ["Disputes à répétition, silence, sentiment de solitude à deux", "Rupture, divorce, reconstruction", "Conflits avec un enfant adulte, un parent, une famille recomposée", "Épuisement des aidants familiaux"],
        "tone": "Chaleureuse, directe, sans parti pris."},
    "theo": {"name": "Théo", "spec": "Épuisement au travail", "theme": "travail",
        "short": "Pour la surcharge, la perte de sens, la peur du lundi, le retour après un arrêt.",
        "approach": "Théo est attentif aux signaux du corps et aux petits changements qui précèdent l'effondrement : le sommeil, l'irritabilité, le dimanche soir qui pèse. Il aide à faire le tri entre ce qui dépend de vous et ce qui ne dépend pas de vous, à poser des limites réalistes, et à connaître vos relais : médecin traitant, médecin du travail, représentants du personnel.",
        "for": ["Burn-out, surcharge, épuisement qui ne passe pas avec le week-end", "Perte de sens, ennui, peur d'aller travailler", "Harcèlement, relations difficiles avec un responsable", "Arrêt de travail et reprise"],
        "tone": "Posé, concret, attentif."},
    "maya": {"name": "Maya", "spec": "Deuil et séparation", "theme": "deuil",
        "short": "Pour parler de l'absence, d'un décès, d'une séparation, sans aller plus vite que votre peine.",
        "approach": "Maya ne cherche pas à vous faire aller mieux vite. Elle offre un espace pour parler de la personne qui manque, de ce qui s'est passé, de la culpabilité et de la colère quand elles sont là. Elle aide à traverser les dates difficiles, à trouver des rituels qui ont du sens pour vous, et à repérer si la peine se fige au point de nécessiter une aide professionnelle.",
        "for": ["Décès d'un conjoint, d'un parent, d'un proche, d'un animal", "Séparation ou divorce vécus comme une perte", "Culpabilité, « j'aurais dû »", "Premières fêtes et anniversaires sans la personne"],
        "tone": "Patiente, présente, sans hâte."},
    "jeanne": {"name": "Jeanne", "spec": "Solitude, retraite, avancée en âge", "theme": "solitude",
        "short": "Pour l'isolement, le passage à la retraite, la santé qui change, le temps qui passe.",
        "approach": "Jeanne prend le temps. Elle s'intéresse à ce que vous avez vécu et à ce que vous savez faire, parce que c'est là que se trouvent les ressources pour la suite. Elle cherche avec vous des liens concrets et réalistes : associations, mairie, voisinage, bénévolat, activités, sans jamais pousser plus vite que vous ne le souhaitez.",
        "for": ["Solitude après 60 ans, veuvage, enfants partis", "Passage à la retraite, sentiment d'inutilité", "Peur de vieillir, santé qui change", "Aidants d'un parent âgé"],
        "tone": "Chaleureuse, lente, jamais condescendante."},
}
GUIDES = {p["name"]: p["spec"] for p in PROFILES.values()}
GUIDE_KEY = {p["name"]: k for k, p in PROFILES.items()}

def portrait(key, cls="portrait", size=""):
    src = f"/static/img/accompagnants/{key}.{PORTRAIT_EXT}"
    if not os.path.exists(os.path.join(ROOT, "static", "img", "accompagnants", f"{key}.{PORTRAIT_EXT}")):
        src = f"/static/img/accompagnants/{key}.svg"
    p = PROFILES[key]
    return f'<img class="{cls}" src="{src}" alt="Portrait illustré de {esc(p["name"])}, accompagnant d\'écoute" width="600" height="600" loading="lazy">'

def esc(s):
    return html.escape(s, quote=True)

def url(path):
    return SITE_URL + path

def layout(title, description, body, path, extra_head="", nav_on="", toc=None, one_col=False, noindex=False):
    if noindex:
        extra_head += '<meta name="robots" content="noindex">'
    canonical = url(path)
    toc_html = ""
    if toc:
        toc_html = '<nav class="toc" aria-label="Sommaire"><h4>Sur cette page</h4>' + "".join(
            f'<a href="#{esc(i)}">{esc(t)}</a>' for i, t in toc
        ) + '<div class="emg"><b>Urgence : 15 ou 3114</b>Gratuit, jour et nuit. Un humain vous répond.</div></nav>'
    def on(k):
        return ' class="on"' if nav_on == k else ""
    return f"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
<link rel="canonical" href="{esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{esc(canonical)}">
<meta property="og:site_name" content="Sereina">
<meta property="og:locale" content="fr_FR">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:ital,wght@0,400;0,500;1,400&display=swap">
<link rel="stylesheet" href="/static/style.css">
{extra_head}
</head>
<body>
<header class="masthead"><div class="in">
  <a class="brand" href="/">Sereina<small>Espace d'écoute</small></a>
  <nav class="topnav" aria-label="Navigation principale">
    <a href="/conseils/"{on('conseils')}>Conseils</a>
    <a href="/accompagnants/"{on('accompagnants')}>Les accompagnants</a>
    <a href="/urgence/"{on('urgence')}>Urgence</a>
    <a href="/credits/"{on('credits')}>Tarifs</a>
    <a class="btn small" href="/parler/">Parler maintenant</a>
    <button class="sizebtn" id="sizeBtn" type="button" aria-pressed="false">Agrandir le texte</button>
  </nav>
</div></header>
<div class="page{' one' if one_col else ''}">
{toc_html}
<main>
{body}
<footer>
  <span>Sereina, {TODAY[:4]}. Un espace d'écoute, pas un service médical.</span>
  <span><a href="/a-propos/">À propos</a> · <a href="/credits/">Tarifs</a> · <a href="/contact/">Contact</a> · <a href="/confidentialite/">Confidentialité</a> · <a href="/cgv/">Conditions</a> · <a href="/mentions-legales/">Mentions légales</a></span>
</footer>
</main>
</div>
<script src="/static/site.js" defer></script>
</body>
</html>
"""

def write(path, content):
    full = os.path.join(DIST, path.lstrip("/"))
    if path.endswith("/"):
        full = os.path.join(full, "index.html")
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(content)

# ---------- Articles ----------
def parse_article(theme, slug):
    p = os.path.join(ROOT, "content", theme, slug + ".md")
    s = open(p, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---\n", s, re.S)
    fm = yaml.safe_load(m.group(1))
    body = s[m.end():].strip()
    return fm, body

def faq_entries(body):
    m = re.search(r"^## Questions fréquentes\s*$(.*?)(?=^## |\Z)", body, re.S | re.M)
    if not m:
        return []
    block = m.group(1)
    out = []
    for q, a in re.findall(r"\*\*(.+?)\*\*\s*\n\s*\n(.+?)(?=\n\s*\n\*\*|\Z)", block, re.S):
        out.append((q.strip(), re.sub(r"\s+", " ", a).strip()))
    return out

# ---------- Maillage automatique (repris de renta-immo lib/seo/auto-link.ts) ----------
# Dictionnaire mot-clé -> URL construit depuis topics.json ; termes triés du plus long au plus court ;
# frontières de mots compatibles avec les accents ; 1 lien par cible et par article, 6 liens automatiques
# au plus par article, jamais dans un titre, un lien existant, une citation ou la FAQ, jamais vers soi-même.
AUTOLINK_MAX = 6
WORD = "A-Za-zÀ-ÖØ-öø-ÿ0-9"
def _norm(t):
    return re.sub(r"\s+", " ", t.strip().lower())
AUTOLINK_TERMS = []
for _a in ARTICLES:
    _url = f"/conseils/{THEMES[_a['theme']]['slug']}/{_a['slug']}/"
    _terms = {_a["keyword"]}
    _terms |= set(x.strip() for x in str(_a.get("aliases", "")).split("|") if x.strip())
    for _t in _terms:
        if len(_t) >= 6:
            AUTOLINK_TERMS.append((_t, _url))
AUTOLINK_TERMS.sort(key=lambda x: -len(x[0]))
AUTOLINK_RE = re.compile("(?<![" + WORD + "])(" + "|".join(re.escape(t) for t, _ in AUTOLINK_TERMS) + ")(?![" + WORD + "])", re.I) if AUTOLINK_TERMS else None
AUTOLINK_MAP = {_norm(t): u for t, u in AUTOLINK_TERMS}

def autolink(html_text, self_url):
    """Ajoute des liens internes dans les paragraphes <p> du corps (hors FAQ, titres, liens existants)."""
    if not AUTOLINK_RE:
        return html_text, 0
    used = set(); count = 0
    faq_at = html_text.find('id="questions-frequentes"')
    head, tail = (html_text[:faq_at], html_text[faq_at:]) if faq_at > 0 else (html_text, "")
    def para(m):
        nonlocal count
        p = m.group(0)
        if "<a " in p or count >= AUTOLINK_MAX:
            return p
        # Ne pas toucher au contenu des balises : on ne remplace que dans le texte hors < >
        parts = re.split(r"(<[^>]+>)", p)
        linked_here = 0
        for i, part in enumerate(parts):
            if part.startswith("<") or count >= AUTOLINK_MAX or linked_here >= 2:
                continue
            def rep(mm):
                nonlocal count, linked_here
                url = AUTOLINK_MAP.get(_norm(mm.group(1)))
                if not url or url == self_url or url in used or count >= AUTOLINK_MAX or linked_here >= 2:
                    return mm.group(0)
                used.add(url); count += 1; linked_here += 1
                return f'<a href="{url}">{mm.group(1)}</a>'
            parts[i] = AUTOLINK_RE.sub(rep, part, count=2)
        return "".join(parts)
    head = re.sub(r"<p>(?:(?!</p>).)*</p>", para, head, flags=re.S)
    return head + tail, count

def render_article(a):
    theme = THEMES[a["theme"]]
    fm, body = parse_article(a["theme"], a["slug"])
    path = f"/conseils/{theme['slug']}/{a['slug']}/"
    md = markdown.Markdown(extensions=["toc"], extension_configs={"toc": {"toc_depth": "2"}})
    md.reset()
    content_html = md.convert(body)
    content_html, nb_auto = autolink(content_html, f"/conseils/{theme['slug']}/{a['slug']}/")
    toc = [(t["id"], html.unescape(t["name"])) for t in md.toc_tokens]
    words = len(re.findall(r"\w+", body))
    reading = max(3, round(words / 200))
    faqs = faq_entries(body)
    # related: 4 autres articles du même thème
    others = [x for x in by_theme[a["theme"]] if x["slug"] != a["slug"]]
    idx = by_theme[a["theme"]].index(a)
    rel = (others[idx:] + others[:idx])[:4]
    rel_html = "".join(
        f'<li><a href="/conseils/{theme["slug"]}/{r["slug"]}/">{esc(r["title"])}</a></li>' for r in rel
    )
    guide = theme["guide"]
    ld = [{
        "@context": "https://schema.org", "@type": "Article",
        "headline": fm["title"], "description": fm["description"],
        "inLanguage": "fr-FR", "datePublished": TODAY, "dateModified": TODAY,
        "author": {"@type": "Organization", "name": "Sereina"},
        "publisher": {"@type": "Organization", "name": "Sereina"},
        "mainEntityOfPage": url(path), "wordCount": words,
        "about": fm.get("keyword", ""),
    }, {
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Accueil", "item": url("/")},
            {"@type": "ListItem", "position": 2, "name": "Conseils", "item": url("/conseils/")},
            {"@type": "ListItem", "position": 3, "name": theme["name"], "item": url(f"/conseils/{theme['slug']}/")},
            {"@type": "ListItem", "position": 4, "name": fm["title"], "item": url(path)},
        ]}]
    if faqs:
        ld.append({"@context": "https://schema.org", "@type": "FAQPage",
                   "mainEntity": [{"@type": "Question", "name": q,
                                   "acceptedAnswer": {"@type": "Answer", "text": ans}} for q, ans in faqs]})
    extra = "".join(f'<script type="application/ld+json">{json.dumps(x, ensure_ascii=False)}</script>' for x in ld)
    h1 = a["title"] if len(a["title"]) <= 80 else fm["title"]
    body_html = f"""
<nav class="crumbs" aria-label="Fil d'Ariane"><a href="/">Accueil</a><span>›</span><a href="/conseils/">Conseils</a><span>›</span><a href="/conseils/{theme['slug']}/">{esc(theme['name'])}</a></nav>
<div class="article-head">
  <h1>{esc(h1)}</h1>
  <div class="meta"><span>Lecture : {reading} min</span><span>Mis à jour le {datetime.date.today().strftime('%d/%m/%Y')}</span><span>Relu par l'équipe Sereina</span></div>
</div>
<article class="article">
{content_html}
<div class="talkbox with-portrait">
  {portrait(GUIDE_KEY[guide], "portrait small")}
  <div><h3>Besoin d'en parler maintenant ?</h3>
  <p><a href="/accompagnants/{GUIDE_KEY[guide]}/">{esc(guide)}</a>, accompagnant d'écoute Sereina pour le thème « {esc(theme['name'])} », est disponible jour et nuit. Un programme d'intelligence artificielle, préparé pour écouter sans jugement. Gratuit pour commencer, sans inscription.</p>
  <a class="btn" href="/parler/?avec={GUIDE_KEY[guide]}">Parler avec {esc(guide)}</a></div>
</div>
<div class="related"><h3>À lire aussi</h3><ul>{rel_html}</ul></div>
<p class="disclaimer">Cette page informe et ne remplace pas une consultation. Sereina n'est pas un service médical. En cas de danger immédiat, appelez le 15 ou le 3114 (gratuit, 24 h/24).</p>
</article>
"""
    write(path, layout(fm["title"], fm["description"], body_html, path, extra, "conseils", toc))
    return {"path": path, "title": fm["title"], "description": fm["description"], "theme": a["theme"], "reading": reading, "words": words, "autolinks": nb_auto}

# ---------- Pages d'index ----------
def render_theme(tkey, infos):
    theme = THEMES[tkey]
    path = f"/conseils/{theme['slug']}/"
    items = "".join(
        f'<li><a href="{i["path"]}">{esc(i["title"])}</a><p>{esc(i["description"])}</p><small>Lecture : {i["reading"]} min</small></li>'
        for i in infos)
    body = f"""
<nav class="crumbs" aria-label="Fil d'Ariane"><a href="/">Accueil</a><span>›</span><a href="/conseils/">Conseils</a></nav>
<section>
<h1>{esc(theme['name'])}</h1>
<p class="lede">{esc(theme['intro'])}</p>
<p class="sub">{len(infos)} articles. Chaque page informe, donne des gestes concrets et dit quand demander de l'aide.</p>
<ul class="list">{items}</ul>
<div class="talkbox with-portrait">{portrait(GUIDE_KEY[theme['guide']], "portrait small")}<div><h3>En parler avec {esc(theme['guide'])}</h3><p>L'accompagnant Sereina préparé pour ce thème vous écoute, jour et nuit. Gratuit pour commencer.</p><a class="btn" href="/parler/?avec={GUIDE_KEY[theme['guide']]}">Parler avec {esc(theme['guide'])}</a></div></div>
</section>"""
    title = f"{theme['name']} : conseils et repères | Sereina"
    write(path, layout(title, theme["intro"], body, path, nav_on="conseils", one_col=True))

def render_conseils_index(all_infos):
    path = "/conseils/"
    items = ""
    for tkey, theme in THEMES.items():
        n = len([i for i in all_infos if i["theme"] == tkey])
        items += f'<li><a class="t" href="/conseils/{theme["slug"]}/">{esc(theme["name"])}</a><p>{esc(theme["intro"])}</p><div class="n">{n} articles</div></li>'
    body = f"""
<section>
<h1>Conseils gratuits pour aller mieux</h1>
<p class="lede">Cent pages écrites simplement, pour comprendre ce que vous vivez et savoir quoi faire. Sans jargon, sans promesse de guérison, avec à chaque fois le moment où il faut demander de l'aide à un professionnel.</p>
<ul class="themes">{items}</ul>
</section>"""
    write(path, layout("Conseils gratuits : anxiété, sommeil, travail, couple, deuil | Sereina",
                       "Des conseils gratuits et concrets pour l'anxiété, le sommeil, le burn-out, le couple, la famille, le deuil et la solitude. Écrits simplement, pour les adultes de 30 à 70 ans et plus.",
                       body, path, nav_on="conseils", one_col=True))

def render_home(all_infos):
    people = "".join(
        f'<li><a href="/accompagnants/{k}/">{portrait(k, "portrait thumb")}<div class="nm">{esc(p["name"])}<small>{esc(p["spec"])}</small></div><div class="ds">{esc(p["short"])}</div><div class="go">Découvrir {esc(p["name"])}</div></a></li>'
        for k, p in PROFILES.items())
    picks = [i for i in all_infos if i["path"].split("/")[-2] in (
        "crise-d-angoisse-que-faire", "reveil-a-3h-du-matin", "burn-out-symptomes", "se-sentir-seul-en-couple",
        "combien-de-temps-dure-un-deuil", "solitude-apres-60-ans")]
    picks_html = "".join(f'<li><a href="{i["path"]}">{esc(i["title"])}</a><p>{esc(i["description"])}</p></li>' for i in picks)
    toc = [("accueil", "Accueil"), ("comment", "Comment ça marche"), ("accompagnants", "Les accompagnants"),
           ("conseils", "Conseils gratuits"), ("urgence", "En cas d'urgence"), ("questions", "Questions fréquentes")]
    body = f"""
<section id="accueil">
  <h1>Parler de ce qui vous pèse, simplement.</h1>
  <p class="lede">Un souci au travail, une inquiétude pour un proche, des nuits difficiles, le sentiment d'être seul. Sur Sereina, vous l'écrivez avec vos mots et un accompagnant d'écoute vous répond. Sans inscription, de jour comme de nuit.</p>
  <div class="run"><p>Les accompagnants sont des programmes d'intelligence artificielle, préparés pour écouter avec respect, aider à y voir plus clair et indiquer vers qui se tourner quand une aide humaine est nécessaire. Ils ne sont pas des psychologues ni des médecins.</p></div>
  <div class="cta"><a class="btn" href="/parler/">Commencer à parler</a></div>
  <div class="alert"><b>Sereina n'est pas un service médical.</b> Aucun diagnostic, aucun traitement. Si vous êtes en danger ou pensez à vous faire du mal, appelez le 15 ou le 3114, gratuits et joignables 24 h/24.</div>
</section>
<section id="comment">
  <h2>Comment ça marche</h2>
  <p class="sub">Trois étapes. Rien à installer.</p>
  <ol class="how">
    <li><div><h3>Choisissez un accompagnant</h3><p>Chacun a été préparé pour un type de difficulté. Vous pourrez en changer quand vous voulez.</p></div></li>
    <li><div><h3>Écrivez ce qui se passe</h3><p>Comme vous le diriez à une personne de confiance. Quelques phrases suffisent ; l'accompagnant vous posera des questions pour bien comprendre.</p></div></li>
    <li><div><h3>Avancez à votre rythme</h3><p>Vous êtes écouté, vous mettez de l'ordre dans ce que vous vivez, vous repartez avec des pistes concrètes. Si votre situation demande un professionnel, on vous dit lequel.</p></div></li>
  </ol>
</section>
<section id="accompagnants">
  <h2>Les accompagnants</h2>
  <p class="sub">Six programmes d'écoute, chacun préparé pour une difficulté et une façon d'écouter. Les portraits sont des illustrations : les accompagnants ne sont pas des personnes réelles.</p>
  <ul class="people">{people}</ul>
</section>
<section id="conseils">
  <h2>Conseils gratuits</h2>
  <p class="sub">Cent pages pour comprendre ce que vous vivez et savoir quoi faire, écrites simplement. <a href="/conseils/">Voir tous les thèmes</a>.</p>
  <ul class="list">{picks_html}</ul>
</section>
<section id="urgence">
  <h2>En cas d'urgence</h2>
  <p class="sub">Si vous êtes en danger, ou si quelqu'un près de vous l'est, parlez à un humain tout de suite. Ces numéros sont gratuits.</p>
  <ul class="numbers">
    <li><b>3114</b><p>Prévention du suicide. Écoute par des professionnels, 24 h/24, 7 j/7.</p></li>
    <li><b>15</b><p>SAMU, urgences médicales.</p></li>
    <li><b>112</b><p>Numéro d'urgence européen, depuis n'importe quel téléphone.</p></li>
    <li><b>3919</b><p>Violences faites aux femmes, écoute et orientation.</p></li>
    <li><b>3977</b><p>Maltraitance des personnes âgées ou en situation de handicap.</p></li>
  </ul>
</section>
<section id="questions">
  <h2>Questions fréquentes</h2>
  <div class="faq">
    <details><summary>Est-ce que je parle à un vrai psychologue ?</summary><p>Non. Les accompagnants sont des programmes d'intelligence artificielle, préparés pour une écoute attentive et des outils simples issus des thérapies cognitives et comportementales. Ils ne sont pas des professionnels de santé et ne remplacent pas une consultation.</p></details>
    <details><summary>Mes conversations sont-elles conservées ?</summary><p>Vos échanges sont conservés le temps de votre session et protégés. Ils ne sont jamais vendus ni partagés. Vous pouvez demander leur suppression à tout moment.</p></details>
    <details><summary>Que se passe-t-il si je vais vraiment mal ?</summary><p>L'accompagnant vous invitera à appeler le 3114 ou le 15 et vous indiquera les bons interlocuteurs. Il ne peut pas appeler à votre place : si vous êtes en danger, composez le numéro vous-même.</p></details>
    <details><summary>Je ne suis pas à l'aise avec l'informatique. Est-ce compliqué ?</summary><p>Non. Rien à installer. Vous choisissez un accompagnant, vous écrivez dans la case, vous cliquez sur « Envoyer ». Le bouton « Agrandir le texte » en haut de la page agrandit tout.</p></details>
    <details><summary>Est-ce gratuit ?</summary><p>Les premiers échanges sont gratuits, sans inscription. Pour continuer au-delà, vous achetez des crédits : 1 crédit = 1 message, sans abonnement ni date limite. <a href="/credits/">Voir les tarifs</a>.</p></details>
  </div>
</section>"""
    extra = '<script type="application/ld+json">' + json.dumps({
        "@context": "https://schema.org", "@type": "WebSite", "name": "Sereina", "url": url("/"), "inLanguage": "fr-FR",
        "description": "Espace d'écoute en ligne avec des accompagnants d'intelligence artificielle, et des conseils gratuits pour aller mieux."}, ensure_ascii=False) + "</script>"
    write("/", layout("Sereina, espace d'écoute : parler de ce qui vous pèse",
                      "Sereina : un espace d'écoute en ligne, jour et nuit. Écrivez ce qui vous pèse, un accompagnant d'écoute vous répond. Conseils gratuits sur l'anxiété, le sommeil, le travail, le couple, le deuil.",
                      body, "/", extra, "", toc))

def render_urgence():
    body = """
<section>
<h1>En cas d'urgence</h1>
<p class="lede">Si vous êtes en danger, si vous pensez à vous faire du mal, ou si quelqu'un près de vous l'est : parlez à un humain tout de suite. Ces numéros sont gratuits et confidentiels.</p>
<ul class="numbers">
  <li><b>3114</b><p>Prévention du suicide. Écoute par des professionnels, 24 h/24, 7 j/7, pour vous ou pour un proche.</p></li>
  <li><b>15</b><p>SAMU, urgences médicales.</p></li>
  <li><b>112</b><p>Numéro d'urgence européen, depuis n'importe quel téléphone, même sans crédit.</p></li>
  <li><b>114</b><p>Urgences par SMS pour les personnes sourdes ou malentendantes.</p></li>
  <li><b>3919</b><p>Violences faites aux femmes, écoute et orientation.</p></li>
  <li><b>3977</b><p>Maltraitance des personnes âgées ou en situation de handicap.</p></li>
</ul>
<p class="sub">Vous trouverez d'autres lignes d'écoute, avec leurs horaires, sur la page <a href="/conseils/se-faire-aider/lignes-d-ecoute-gratuites/">Lignes d'écoute gratuites en France</a>.</p>
</section>"""
    write("/urgence/", layout("Urgence : qui appeler tout de suite | Sereina", "Numéros d'urgence gratuits en France : 3114 (prévention du suicide), 15, 112, 114, 3919, 3977. Qui appeler et pour quoi.", body, "/urgence/", nav_on="urgence", one_col=True))

def packs_html():
    out = ""
    for p in PACKS:
        unit = f"{p['cents']/p['credits']/100:.2f}".replace(".", ",")
        sel = p["key"] == DEFAULT_PACK
        out += f'<label class="pack{" sel" if sel else ""}"><input type="radio" name="pack" value="{p["key"]}"{" checked" if sel else ""}><span class="pl">{esc(p["label"])}</span><span class="pc">{p["credits"]} crédits</span><span class="pp">{p["price"]}</span><span class="pu">{unit} € le message</span></label>'
    return out

def render_parler():
    body = """
<section>
<h1>Parler maintenant</h1>
<p class="sub">Choisissez un accompagnant, écrivez dans la case, puis cliquez sur « Envoyer ». Les réponses sont rédigées par un programme d'intelligence artificielle à partir de ce que vous écrivez.</p>
<div id="app" class="talk">
  <div class="talk-head"><div class="with"><img class="portrait mini" id="headImg" src="/static/img/accompagnants/clara.svg" alt="" width="48" height="48">Avec <span id="headName">Clara</span><small id="headRole">Anxiété et stress</small></div>
  <div class="tools"><span class="quota" id="quota"></span>
  <select id="guide" aria-label="Changer d'accompagnant"><option value="clara">Clara, anxiété et stress</option><option value="samuel">Samuel, sommeil et fatigue</option><option value="ines">Inès, couple et famille</option><option value="theo">Théo, épuisement au travail</option><option value="maya">Maya, deuil et séparation</option><option value="jeanne">Jeanne, solitude, retraite, âge</option></select>
  <button type="button" class="ghost" id="resetBtn">Recommencer</button></div></div>
  <div class="log" id="log" aria-live="polite"></div>
  <form class="composer" id="composer"><label for="input" hidden>Votre message</label><textarea id="input" rows="2" placeholder="Écrivez ici ce qui vous préoccupe"></textarea><div class="acts"><button class="send" id="sendBtn" type="submit">Envoyer</button><button class="stop" id="stopBtn" type="button" hidden>Arrêter la réponse</button></div></form>
  <p class="hint">La touche Entrée envoie le message. Pour aller à la ligne, utilisez Maj + Entrée. <a href="/mon-compte/">Mes crédits et mes données</a>.</p>
</div>
<div class="alert"><b>Sereina n'est pas un service médical.</b> Si vous êtes en danger, appelez le 15 ou le 3114 (gratuit, 24 h/24).</div>
</section>

<div class="modal" id="consentModal" hidden role="dialog" aria-modal="true" aria-labelledby="consentTitle">
  <div class="modal-box">
    <h2 id="consentTitle">Avant de commencer</h2>
    <p>Vous allez parler avec un programme d'intelligence artificielle, pas avec un professionnel de santé. Pour vous répondre, ce que vous écrivez est transmis à notre prestataire d'IA et conservé le temps de votre accompagnement, puis supprimé automatiquement. Vous pouvez tout effacer quand vous voulez depuis <a href="/mon-compte/">Mon compte</a>.</p>
    <p>Si vos messages laissent penser que vous êtes en danger, un membre de notre équipe peut être prévenu pour vous proposer de l'aide. En cas d'urgence, appelez le 15 ou le 3114.</p>
    <label class="check"><input type="checkbox" id="ck18"> J'ai 18 ans ou plus.</label>
    <label class="check"><input type="checkbox" id="ckData"> J'accepte que mes messages soient traités comme décrit dans la <a href="/confidentialite/">politique de confidentialité</a>.</label>
    <div class="modal-acts"><button class="btn" id="consentOk" type="button" disabled>Commencer</button><a class="ghost" href="/">Pas maintenant</a></div>
  </div>
</div>

<div class="modal" id="payModal" hidden role="dialog" aria-modal="true" aria-labelledby="payTitle">
  <div class="modal-box">
    <h2 id="payTitle">Continuer la conversation</h2>
    <p>Vous avez utilisé les échanges gratuits. Pour continuer avec <span class="payGuide">votre accompagnant</span>, choisissez un pack de crédits. <b>1 crédit = 1 message envoyé.</b> Les crédits n'expirent pas.</p>
    <div class="packs" id="packs">PACKS_HTML</div>
    <label class="check"><input type="checkbox" id="autoCk" checked> Recharger automatiquement le même pack quand mes crédits sont épuisés, avec la carte enregistrée. Désactivable à tout moment dans « Mon compte ».</label>
    <div class="modal-acts"><a class="btn" id="buyBtn" href="/api/checkout?pack=DEFAULT_PACK&auto=1">Acheter et continuer</a><button class="ghost" type="button" id="payLater">Plus tard</button></div>
    <p class="fine">Paiement sécurisé par Stripe. Sereina ne voit jamais votre numéro de carte. <a href="/cgv/">Conditions</a>.</p>
  </div>
</div>
<script src="/static/chat.js" defer></script>"""
    srcs = {k: (f"/static/img/accompagnants/{k}.{PORTRAIT_EXT}" if os.path.exists(os.path.join(ROOT, "static", "img", "accompagnants", f"{k}.{PORTRAIT_EXT}")) else f"/static/img/accompagnants/{k}.svg") for k in PROFILES}
    body = body.replace('<script src="/static/chat.js" defer></script>', f'<script src="/static/chat.js" defer data-portraits=\'{json.dumps(srcs)}\'></script>')
    write("/parler/", layout("Parler maintenant avec un accompagnant d'écoute | Sereina", "Écrivez ce qui vous pèse et parlez avec un accompagnant d'écoute Sereina, jour et nuit. Les premiers échanges sont gratuits, sans inscription.", body.replace("PACKS_HTML", packs_html()).replace("DEFAULT_PACK", DEFAULT_PACK), "/parler/", one_col=True))

def render_accompagnants(all_infos):
    cards = "".join(f'''<li><a href="/accompagnants/{k}/">{portrait(k, "portrait thumb")}<div class="nm">{esc(p["name"])}<small>{esc(p["spec"])}</small></div><div class="ds">{esc(p["short"])}</div><div class="go">Découvrir {esc(p["name"])}</div></a></li>''' for k, p in PROFILES.items())
    body = f"""
<section>
<h1>Les accompagnants d'écoute</h1>
<p class="lede">Six programmes d'intelligence artificielle, chacun préparé pour une difficulté et une façon d'écouter. Ils ne sont pas des personnes réelles ni des professionnels de santé ; les portraits sont des illustrations. Ils ont été conçus pour écouter avec respect, aider à y voir plus clair, et dire quand une aide humaine est nécessaire.</p>
<ul class="people">{cards}</ul>
</section>"""
    write("/accompagnants/", layout("Les accompagnants d'écoute Sereina", "Clara, Samuel, Inès, Théo, Maya, Jeanne : six accompagnants d'écoute, chacun préparé pour une difficulté. Programmes d'intelligence artificielle, disponibles jour et nuit.", body, "/accompagnants/", nav_on="accompagnants", one_col=True))
    for k, p in PROFILES.items():
        theme = THEMES[p["theme"]]
        arts = [i for i in all_infos if i["theme"] == p["theme"]][:6]
        if p["theme"] == "couple":
            arts += [i for i in all_infos if i["theme"] == "famille"][:3]
        arts_html = "".join(f'<li><a href="{i["path"]}">{esc(i["title"])}</a></li>' for i in arts)
        fors = "".join(f"<li>{esc(x)}</li>" for x in p["for"])
        path = f"/accompagnants/{k}/"
        body = f"""
<nav class="crumbs" aria-label="Fil d'Ariane"><a href="/">Accueil</a><span>›</span><a href="/accompagnants/">Les accompagnants</a></nav>
<section class="profile">
  <div class="profile-head">
    {portrait(k, "portrait large")}
    <div>
      <h1>{esc(p["name"])}</h1>
      <p class="spec">{esc(p["spec"])} · accompagnant d'écoute (intelligence artificielle)</p>
      <p class="lede">{esc(p["short"])}</p>
      <div class="cta"><a class="btn" href="/parler/?avec={k}">Parler avec {esc(p["name"])}</a></div>
    </div>
  </div>
  <h2>Sa façon d'écouter</h2>
  <div class="run"><p>{esc(p["approach"])}</p><p><strong>Ton :</strong> {esc(p["tone"])}</p></div>
  <h2>Dans quelles situations</h2>
  <ul class="plain big">{fors}</ul>
  <h2>Ce que {esc(p["name"])} n'est pas</h2>
  <div class="run"><p>{esc(p["name"])} est un programme d'intelligence artificielle, pas une personne et pas un professionnel de santé. {esc(p["name"])} ne pose pas de diagnostic, ne prescrit rien et ne remplace pas une consultation. Si vos messages laissent penser que vous êtes en danger, {esc(p["name"])} vous donnera le 3114 et le 15, et un membre humain de l'équipe Sereina pourra vous proposer de l'aide.</p></div>
  <h2>Conseils sur ce thème</h2>
  <ul class="related-list">{arts_html}</ul>
  <p class="sub"><a href="/conseils/{theme['slug']}/">Tous les articles « {esc(theme['name'])} »</a></p>
</section>"""
        write(path, layout(f"{p['name']}, accompagnant d'écoute : {p['spec']} | Sereina", f"{p['name']} est l'accompagnant d'écoute Sereina pour {p['spec'].lower()}. {p['short']} Programme d'intelligence artificielle, disponible jour et nuit.", body, path, nav_on="accompagnants", one_col=True))

def render_pages():
    # Crédits (tarifs)
    plans = "".join(f'''<div class="plan{" main" if p["key"] == DEFAULT_PACK else ""}"><div class="pname">{esc(p["label"])}</div><div class="pprice">{p["price"]}</div><p><b>{p["credits"]} crédits</b>, soit {p["credits"]} messages. {f"{p['cents']/p['credits']/100:.2f}".replace(".", ",")} € le message.</p><a class="btn" href="/api/checkout?pack={p["key"]}&auto=1">Choisir</a></div>''' for p in PACKS)
    body = f"""
<section>
<h1>Les crédits Sereina</h1>
<p class="lede">Les premiers échanges sont gratuits, sans inscription. Ensuite, vous achetez des crédits : <b>1 crédit = 1 message envoyé</b> à un accompagnant. Pas d'abonnement, pas de date limite, les crédits restent disponibles jusqu'à ce que vous les utilisiez.</p>
<div class="pricing three">
  <div class="plan"><div class="pname">Essai</div><div class="pprice">0 €</div><p>{FREE_MINUTES} minutes ou {FREE_MESSAGES} messages pour voir si Sereina vous convient. Aucune carte demandée.</p><a class="btn" href="/parler/">Essayer</a></div>
  {plans}
</div>
<div class="faq">
  <details><summary>Comment fonctionne la recharge automatique ?</summary><p>À l'achat, une case « recharger automatiquement » est cochée : quand vos crédits tombent à zéro en pleine conversation, le même pack est racheté avec la carte enregistrée, sans vous interrompre. Vous pouvez la décocher avant de payer, ou la désactiver ensuite depuis <a href="/mon-compte/">Mon compte</a>. Sans recharge automatique, rien n'est jamais prélevé sans que vous cliquiez vous-même sur « Acheter ».</p></details>
  <details><summary>Les crédits expirent-ils ?</summary><p>Non. Ils restent sur votre compte, lié à cet appareil, jusqu'à ce que vous les utilisiez.</p></details>
  <details><summary>Le paiement est-il sécurisé ?</summary><p>Oui. Il est confié à Stripe, prestataire de paiement utilisé par des millions de sites. Sereina ne voit ni ne stocke votre numéro de carte.</p></details>
  <details><summary>Puis-je me faire rembourser ?</summary><p>Les crédits non utilisés d'un pack peuvent être remboursés sur simple demande via la <a href="/contact/">page contact</a>, dans les quatorze jours suivant l'achat.</p></details>
  <details><summary>Est-ce que ça remplace un psychologue ?</summary><p>Non. Sereina est un espace d'écoute. Si votre situation demande un professionnel de santé, les accompagnants vous le diront et vous indiqueront vers qui vous tourner.</p></details>
</div>
</section>"""
    write("/credits/", layout("Crédits Sereina : 1 crédit = 1 message, sans abonnement", f"Les premiers échanges sont gratuits. Ensuite des packs de crédits {PRICE_LABEL}, 1 crédit par message, sans abonnement ni date limite, recharge automatique désactivable.", body, "/credits/", nav_on="credits", one_col=True))
    write("/abonnement/", f'<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/credits/"><link rel="canonical" href="{url("/credits/")}"><title>Crédits Sereina</title></head><body><a href="/credits/">Voir les crédits</a></body></html>')

    # Mon compte
    body = """
<section>
<h1>Mon compte</h1>
<p class="sub">Sereina ne demande ni e-mail ni mot de passe : votre espace est lié à cet appareil et à ce navigateur.</p>
<dl class="kv" id="account">
  <dt>Crédits disponibles</dt><dd id="accCredits">Chargement…</dd>
  <dt>Échanges gratuits</dt><dd id="accFree"></dd>
  <dt>Recharge automatique</dt><dd id="accAuto"></dd>
</dl>
<div class="acts"><a class="btn" href="/credits/">Acheter des crédits</a> <a class="ghost" id="portalBtn" href="/api/portal" hidden>Carte enregistrée et reçus</a></div>
<h2>Mes achats</h2>
<ul class="list" id="purchases"><li>Aucun achat pour le moment.</li></ul>
<h2>Mes données</h2>
<p class="sub">Vos conversations sont conservées pour que vous puissiez reprendre là où vous en étiez, puis supprimées automatiquement après la durée indiquée dans la <a href="/confidentialite/">politique de confidentialité</a>. Vous pouvez tout effacer maintenant : conversations, niveau d'alerte, coordonnées éventuelles, crédits restants. Cette action est définitive.</p>
<div class="acts"><button class="btn danger" id="deleteBtn" type="button">Supprimer toutes mes données</button></div>
<p class="sub" id="deleteMsg"></p>
</section>
<div class="modal" id="deleteModal" hidden role="dialog" aria-modal="true" aria-labelledby="delTitle"><div class="modal-box">
  <h2 id="delTitle">Supprimer vos données ?</h2>
  <p>Vos conversations, votre profil et vos crédits restants seront effacés tout de suite et ne pourront pas être récupérés. La recharge automatique sera désactivée.</p>
  <div class="modal-acts"><button class="btn danger" id="deleteOk" type="button">Oui, tout supprimer</button><button class="ghost" id="deleteNo" type="button">Annuler</button></div>
</div></div>
<script src="/static/account.js" defer></script>"""
    write("/mon-compte/", layout("Mon compte | Sereina", "Vos crédits, vos achats, la recharge automatique et la suppression de vos données.", body, "/mon-compte/", one_col=True, noindex=True))

    # Contact
    body = """
<section>
<h1>Contact</h1>
<p class="sub">Une question sur le service, les crédits, vos données ? Écrivez-nous. Nous répondons en général sous deux jours ouvrés. <b>Cette page n'est pas un service d'urgence</b> : en cas de danger, appelez le 15 ou le 3114.</p>
<form class="form" id="contactForm">
  <div class="hp" aria-hidden="true"><label>Site web<input name="website" tabindex="-1" autocomplete="off"></label></div>
  <label>Votre e-mail<br><input type="email" name="email" required autocomplete="email"></label>
  <label>Sujet<br><select name="subject"><option>Question sur le service</option><option>Crédits ou paiement</option><option>Mes données personnelles</option><option>Signaler un problème</option><option>Presse, partenariat</option><option>Autre</option></select></label>
  <label>Message<br><textarea name="message" rows="6" required></textarea></label>
  <button class="btn" type="submit">Envoyer</button>
  <p class="sub" id="contactMsg"></p>
</form>
</section>
<script src="/static/contact.js" defer></script>"""
    write("/contact/", layout("Contact | Sereina", "Contacter l'équipe Sereina pour une question sur le service, les crédits ou vos données.", body, "/contact/", one_col=True))

    # À propos
    body = """
<section>
<h1>À propos de Sereina</h1>
<div class="run">
<p>Sereina est né d'un constat simple : beaucoup de gens vont mal sans oser en parler, ou sans trouver quelqu'un de disponible au moment où ça pèse le plus, souvent le soir ou la nuit. Les délais pour voir un psychologue se comptent en semaines, et tout le monde n'a pas un proche à qui se confier.</p>
<p>Nous avons donc construit un espace d'écoute qui répond tout de suite. Les accompagnants Sereina sont des programmes d'intelligence artificielle, préparés avec soin pour écouter avec respect, aider à mettre des mots sur ce qui se passe, proposer des gestes concrets issus des approches reconnues, et surtout savoir dire quand il faut une aide humaine, et laquelle.</p>
<p>Nous disons clairement ce que Sereina n'est pas : ce n'est pas un service médical, les accompagnants ne sont pas des soignants, ils ne posent aucun diagnostic et ne prescrivent rien. Et si une conversation laisse penser qu'une personne est en danger, une équipe humaine est prévenue pour lui proposer de l'aide.</p>
<p>À côté du chat, nous publions des conseils gratuits, écrits simplement, pour les adultes de 30 à 70 ans et plus qui cherchent à comprendre ce qu'ils vivent : anxiété, sommeil, épuisement au travail, couple, famille, deuil, solitude.</p>
</div>
<div class="cta"><a class="btn" href="/parler/">Commencer à parler</a></div>
</section>"""
    write("/a-propos/", layout("À propos de Sereina, espace d'écoute", "Pourquoi Sereina existe, ce que sont les accompagnants d'écoute, et ce que le service n'est pas.", body, "/a-propos/", one_col=True))

    # Confidentialité
    body = f"""
<section>
<h1>Politique de confidentialité</h1>
<p class="sub">Dernière mise à jour : {datetime.date.today().strftime('%d/%m/%Y')}. Cette page explique, en termes simples, ce que nous faisons de vos données.</p>
<div class="run legal">
<h2>Qui est responsable</h2>
<p>Le responsable du traitement est [Raison sociale], [adresse]. Contact pour vos données : [e-mail du DPO ou du responsable].</p>
<h2>Ce que nous collectons</h2>
<p>Lorsque vous utilisez le chat : le contenu de vos messages et des réponses, l'accompagnant choisi, la date et l'heure, un identifiant technique stocké dans un cookie sur votre appareil, votre adresse IP et le type de navigateur. Si vous les donnez vous-même pendant une conversation, un prénom, un numéro de téléphone ou une ville. Lorsque vous achetez des crédits : les informations de paiement sont collectées et conservées par Stripe, pas par nous ; nous ne recevons qu'un identifiant client, un identifiant de moyen de paiement (pour la recharge automatique, si vous l'avez activée) et la confirmation du paiement. Lorsque vous nous écrivez via le formulaire de contact : votre e-mail et votre message.</p>
<h2>Pourquoi</h2>
<p>Pour faire fonctionner le chat et vous répondre ; pour évaluer, à chaque message, si vous pourriez être en danger et, le cas échéant, prévenir un membre de notre équipe afin qu'il vous propose de l'aide (intérêt vital) ; pour gérer la période gratuite, les crédits et les achats ; pour répondre à vos demandes ; pour assurer la sécurité du service.</p>
<p>Vos messages peuvent révéler des informations sur votre santé. Nous les traitons uniquement avec votre consentement explicite, demandé avant votre premier message, que vous pouvez retirer à tout moment en supprimant vos données.</p>
<h2>Qui y a accès</h2>
<p>Notre prestataire d'intelligence artificielle (Anthropic), qui génère les réponses et l'évaluation de risque à partir du texte que nous lui transmettons ; notre hébergeur ; Stripe pour les paiements ; les membres habilités de notre équipe, uniquement pour les situations d'alerte et le support. Nous ne vendons jamais vos données et ne les utilisons pas pour de la publicité.</p>
<h2>Combien de temps</h2>
<p>Les conversations sont supprimées automatiquement après {RETENTION_DAYS} jours. Les données liées aux achats sont conservées le temps de la relation contractuelle, puis selon les obligations comptables. Vous pouvez supprimer vos conversations à tout moment depuis <a href="/mon-compte/">Mon compte</a>.</p>
<h2>Vos droits</h2>
<p>Accès, rectification, suppression, limitation, opposition, portabilité, et retrait du consentement : écrivez-nous via la <a href="/contact/">page contact</a> ou à [e-mail]. Vous pouvez aussi saisir la CNIL.</p>
<h2>Cookies</h2>
<p>Nous utilisons un seul cookie, strictement nécessaire, pour reconnaître votre appareil entre deux messages. Aucun cookie publicitaire, aucun traceur tiers. Votre préférence de taille de texte est mémorisée localement dans votre navigateur.</p>
</div>
</section>"""
    write("/confidentialite/", layout("Politique de confidentialité | Sereina", "Ce que Sereina fait de vos données : messages, évaluation de risque, crédits, durée de conservation, vos droits.", body, "/confidentialite/", one_col=True))

    # CGV / CGU
    body = f"""
<section>
<h1>Conditions d'utilisation et de vente</h1>
<p class="sub">Dernière mise à jour : {datetime.date.today().strftime('%d/%m/%Y')}.</p>
<div class="run legal">
<h2>Le service</h2>
<p>Sereina est un espace d'écoute en ligne édité par [Raison sociale]. Les accompagnants sont des programmes d'intelligence artificielle. Le service ne constitue pas un acte médical, ne pose aucun diagnostic, ne prescrit aucun traitement et ne remplace pas une consultation auprès d'un professionnel de santé. En cas d'urgence, l'utilisateur doit contacter le 15, le 112 ou le 3114.</p>
<h2>Accès</h2>
<p>Le service est réservé aux personnes majeures. Les premiers échanges sont gratuits ({FREE_MINUTES} minutes ou {FREE_MESSAGES} messages). Au-delà, l'accès au chat nécessite des crédits.</p>
<h2>Crédits et paiement</h2>
<p>Au-delà de l'essai gratuit, l'accès au chat se fait par crédits : un crédit est consommé par message envoyé à un accompagnant. Les crédits s'achètent par packs dont les prix, toutes taxes comprises, sont affichés sur la page « Tarifs » et avant tout paiement. Le paiement est réalisé par carte bancaire via Stripe. Les crédits n'ont pas de date d'expiration tant que le compte existe ; ils sont perdus si l'utilisateur supprime ses données.</p>
<p>Recharge automatique : si l'utilisateur l'a activée (case cochée lors de l'achat, modifiable à tout moment dans « Mon compte »), le même pack est racheté automatiquement avec la carte enregistrée lorsque les crédits sont épuisés, et un reçu est envoyé par Stripe. L'utilisateur peut désactiver cette option à tout moment ; aucun prélèvement n'a lieu après désactivation.</p>
<p>Droit de rétractation : les crédits non utilisés peuvent être remboursés sur demande dans les quatorze jours suivant l'achat, au prorata des crédits restants. [À confirmer par votre conseil.]</p>
<h2>Bon usage</h2>
<p>L'utilisateur s'engage à ne pas utiliser le service pour nuire à autrui, à ne pas tenter de contourner ses protections, et à ne pas en reproduire le contenu à des fins commerciales. Sereina peut suspendre un accès en cas d'abus.</p>
<h2>Responsabilité</h2>
<p>Sereina met en œuvre les moyens raisonnables pour fournir un service disponible et des réponses appropriées, sans garantie de résultat. Les réponses sont générées automatiquement et peuvent contenir des erreurs ; elles ne doivent pas être considérées comme un avis médical. La responsabilité de Sereina ne saurait être engagée pour des décisions prises sur la seule base du service.</p>
<h2>Litiges</h2>
<p>En cas de différend, l'utilisateur peut contacter le service client via la page contact, puis recourir gratuitement au médiateur de la consommation : [nom et coordonnées du médiateur]. Le droit français s'applique.</p>
</div>
</section>"""
    write("/cgv/", layout("Conditions d'utilisation et de vente | Sereina", "Conditions d'utilisation du service Sereina et conditions d'achat des crédits.", body, "/cgv/", one_col=True))

def render_misc():
    body = """
<section><h1>Mentions légales</h1>
<div class="run">
<p><strong>Éditeur du site</strong> : [Raison sociale], [forme juridique], [capital], [adresse], [RCS], [n° TVA]. Directeur de la publication : [nom].</p>
<p><strong>Hébergeur</strong> : [nom et adresse de l'hébergeur].</p>
<p><strong>Nature du service</strong> : Sereina est un espace d'écoute et d'information. Les accompagnants sont des programmes d'intelligence artificielle. Le service ne constitue pas un acte médical, ne pose aucun diagnostic et ne remplace pas une consultation auprès d'un professionnel de santé. En cas d'urgence, appelez le 15 ou le 3114.</p>
<p><strong>Données personnelles</strong> : voir la <a href="/confidentialite/">politique de confidentialité</a>. <strong>Abonnement</strong> : voir les <a href="/cgv/">conditions d'utilisation et de vente</a>.</p>
</div></section>"""
    write("/mentions-legales/", layout("Mentions légales | Sereina", "Mentions légales et informations sur le service Sereina.", body, "/mentions-legales/", one_col=True))
    body404 = """<section><h1>Page introuvable</h1><p class="lede">Cette page n'existe pas ou a été déplacée.</p><div class="cta"><a class="btn" href="/conseils/">Voir les conseils</a></div></section>"""
    write("/404.html", layout("Page introuvable | Sereina", "Page introuvable.", body404, "/404.html", one_col=True))

def render_sitemap(paths):
    items = "".join(f"<url><loc>{esc(url(p))}</loc><lastmod>{TODAY}</lastmod></url>" for p in paths)
    write("/sitemap.xml", f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{items}</urlset>\n')
    write("/robots.txt", f"User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\nSitemap: {url('/sitemap.xml')}\n")

def main():
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST)
    shutil.copytree(os.path.join(ROOT, "static"), os.path.join(DIST, "static"))
    infos = [render_article(a) for a in ARTICLES]
    for tkey in THEMES:
        render_theme(tkey, [i for i in infos if i["theme"] == tkey])
    render_conseils_index(infos)
    render_home(infos)
    render_urgence()
    render_parler()
    render_misc()
    render_pages()
    render_accompagnants(infos)
    paths = ["/", "/conseils/", "/parler/", "/urgence/", "/abonnement/", "/accompagnants/"] + [f"/accompagnants/{k}/" for k in PROFILES] + [ "/a-propos/", "/contact/", "/confidentialite/", "/cgv/"] + [f"/conseils/{THEMES[t]['slug']}/" for t in THEMES] + [i["path"] for i in infos]
    render_sitemap(paths)
    json.dump(infos, open(os.path.join(DIST, "articles.json"), "w"), ensure_ascii=False, indent=1)
    print(f"{len(infos)} articles, {len(paths)} URL, mots au total : {sum(i['words'] for i in infos)}, liens internes automatiques : {sum(i['autolinks'] for i in infos)}")

if __name__ == "__main__":
    main()
