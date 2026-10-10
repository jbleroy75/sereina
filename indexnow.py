#!/usr/bin/env python3
"""Signale aux moteurs de recherche les pages nouvelles ou modifiées depuis le dernier envoi (protocole IndexNow).

IndexNow est utilisé par Bing, Yandex, Seznam, Naver… (et donc par les assistants qui s'appuient sur Bing).
Google ne l'utilise pas : pour Google, déclarez une fois le sitemap dans la Search Console ; il le relit seul,
et la date <lastmod> de chaque page ne change que quand son contenu change (voir build.py, .seo-state.json).
L'API Google Indexing n'est volontairement pas utilisée : Google la réserve aux offres d'emploi et aux vidéos en direct.

À lancer après chaque déploiement :
    INDEXNOW_KEY=... python3 build.py --site-url https://www.sereina.fr
    INDEXNOW_KEY=... python3 indexnow.py --site-url https://www.sereina.fr [--dry-run] [--all]
"""
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(ROOT, ".seo-state.json")


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    key = os.environ.get("INDEXNOW_KEY", "")
    site = (arg("--site-url") or os.environ.get("SITE_URL") or "https://www.sereina.fr").rstrip("/")
    dry, everything = "--dry-run" in sys.argv, "--all" in sys.argv
    if not key:
        sys.exit("INDEXNOW_KEY manquant (une chaîne de 32 caractères hexadécimaux, par exemple : openssl rand -hex 16).")
    state = json.load(open(STATE))
    paths = state.get("_sitemap", [])
    todo = [p for p in paths if everything or state.get(p, {}).get("pinged") != state.get(p, {}).get("hash")]
    if not todo:
        print("Rien de nouveau à signaler.")
        return
    host = site.split("://", 1)[1]
    urls = [site + p for p in todo]
    print(f"{len(urls)} page(s) à signaler.")
    if dry:
        print("\n".join(urls[:20]) + ("\n…" if len(urls) > 20 else ""))
        return
    for i in range(0, len(urls), 10000):
        body = json.dumps({"host": host, "key": key, "keyLocation": f"{site}/{key}.txt", "urlList": urls[i:i + 10000]}).encode()
        req = urllib.request.Request("https://api.indexnow.org/indexnow", data=body, method="POST",
                                     headers={"Content-Type": "application/json; charset=utf-8"})
        with urllib.request.urlopen(req, timeout=30) as r:
            print(f"IndexNow : HTTP {r.status}")  # 200 ou 202 = accepté
    for p in todo:
        state[p]["pinged"] = state[p]["hash"]
    json.dump(state, open(STATE, "w"), ensure_ascii=False, indent=0)


if __name__ == "__main__":
    main()
