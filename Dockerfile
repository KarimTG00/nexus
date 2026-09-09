# --- étape 1 : compilation du dashboard ------------------------------------
# Vite fige les variables VITE_* à la COMPILATION. Le dashboard étant servi par
# le service web sur la même origine, il n'en a besoin d'aucune : il appelle
# des chemins relatifs.
FROM node:24-alpine AS dashboard

WORKDIR /dashboard
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build


# --- étape 2 : image d'exécution --------------------------------------------
FROM node:24-alpine

WORKDIR /app

# Couche de dépendances séparée : le cache Docker n'est invalidé que si
# package.json change, pas à chaque modification de code.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY --from=dashboard /dashboard/dist ./dashboard/dist

ENV NODE_ENV=production

# Deux points d'entrée depuis la MÊME image, choisis par la commande du service :
#   node src/workers/pipeline.js   le pipeline — aucun port, ne pas lui donner de domaine
#   node src/workers/api.js        le service web — webhooks, API et dashboard
#
# Un service Railway qui expose un domaine DOIT lancer le second : un domaine
# pointé sur le pipeline renvoie 502, puisque rien n'écoute.
CMD ["node", "src/workers/api.js"]
