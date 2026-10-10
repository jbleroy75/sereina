FROM python:3.12-slim AS build
WORKDIR /src
COPY build.py topics.json ./
COPY content ./content
COPY static ./static
RUN pip install --no-cache-dir markdown pyyaml
ARG SITE_URL=https://www.votre-domaine.fr
ARG PACKS="petit:20:490:Petit pack,moyen:60:1290:Pack confort,grand:150:2490:Grand pack"
ENV PACKS=$PACKS
RUN python3 build.py --site-url $SITE_URL

FROM node:20-slim
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server ./
COPY --from=build /src/dist /app/dist
ENV DIST_DIR=/app/dist DB_PATH=/app/data/sereina.db PORT=3000
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server.js"]
