FROM node:24-alpine

WORKDIR /app

# Couche de dépendances séparée : le cache Docker n'est invalidé que si
# package.json change, pas à chaque modification de code.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production

# Pas de port exposé : c'est un worker, pas un service web.
CMD ["node", "src/workers/pipeline.js"]
