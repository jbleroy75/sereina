#!/usr/bin/env bash
# Installation sur un serveur Debian/Ubuntu neuf. À lancer en root : bash install.sh www.votre-domaine.fr
set -euo pipefail
DOMAIN="${1:?Usage: install.sh www.votre-domaine.fr}"
apt-get update && apt-get install -y curl git python3 python3-pip debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
id -u sereina &>/dev/null || useradd -r -m -d /opt/sereina -s /usr/sbin/nologin sereina
SRC="$(cd "$(dirname "$0")/.." && pwd)"
rsync -a --delete --exclude node_modules --exclude data --exclude .seo-state.json --exclude server/.env "$SRC/" /opt/sereina/
cd /opt/sereina && pip3 install --break-system-packages markdown pyyaml reportlab pillow && python3 build.py --site-url "https://$DOMAIN" && python3 build_guides.py
cd /opt/sereina/server && npm install --omit=dev
[ -f .env ] || { cp .env.example .env; echo ">>> Remplissez /opt/sereina/server/.env puis : systemctl restart sereina"; }
chown -R sereina:sereina /opt/sereina
sed "s/www.votre-domaine.fr/$DOMAIN/g; s/votre-domaine.fr/${DOMAIN#www.}/g" "$SRC/deploy/Caddyfile" > /etc/caddy/Caddyfile
cp "$SRC/deploy/sereina.service" /etc/systemd/system/sereina.service
systemctl daemon-reload && systemctl enable --now sereina && systemctl reload caddy
echo "Sereina installé : https://$DOMAIN  (back-office : https://$DOMAIN/admin/)"
