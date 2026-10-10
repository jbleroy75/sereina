FROM python:3.12-slim AS build
WORKDIR /src
COPY build.py build_guides.py topics.json ./
COPY content ./content
COPY static ./static
COPY pwa ./pwa
COPY guides ./guides
COPY assets ./assets
RUN pip install --no-cache-dir markdown pyyaml reportlab pillow
ARG SITE_URL=https://www.votre-domaine.fr
ARG PACKS="petit:20:490:Petit pack,moyen:60:1290:Pack confort,grand:150:2490:Grand pack"
ENV PACKS=$PACKS
RUN python3 build.py --site-url $SITE_URL && python3 build_guides.py --out /src/private/guides

FROM node:20-slim
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server ./
COPY --from=build /src/dist /app/dist
COPY --from=build /src/private/guides /app/private/guides
ENV DIST_DIR=/app/dist GUIDES_DIR=/app/private/guides DB_PATH=/app/data/sereina.db PORT=3000
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server.js"]
