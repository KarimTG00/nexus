/**
 * Validation des variables d'environnement au démarrage.
 * Mieux vaut échouer tout de suite avec un message clair qu'au premier appel réseau.
 */

const SPEC = {
  MONGODB_URI:       { required: true,  desc: 'URI du cluster MongoDB' },
  MOBULA_KEY:        { required: true,  desc: 'clé API Mobula (découverte + market data)' },
  HELIUS_KEY:        { required: true,  desc: 'clé API Helius (RPC Solana : mint/freeze authority)' },
  HELIUS_WEBHOOK_ID: { required: false, desc: 'webhook Helius — collecteur de swaps (P7)' },
  REDIS_URL:         { required: false, desc: 'Redis — rate limiter partagé (P1). Repli mémoire si absent.' },
  TELEGRAM_BOT_TOKEN: { required: false, desc: 'bot Telegram (P8) — alias accepte : TELEGRAM_TOKEN' },
  TELEGRAM_CHAT_ID:  { required: false, desc: 'salon de destination des alertes (P8)' },
  TELEGRAM_WEBHOOK_SECRET: { required: false, desc: 'jeton secret du webhook Telegram' },
  HELIUS_WEBHOOK_SECRET:   { required: false, desc: 'en-tete d authentification du webhook Helius' },
  API_TOKEN:         { required: false, desc: 'jeton porteur pour un client non navigateur' },
  DASHBOARD_USER:    { required: false, desc: 'identifiant Basic protegeant dashboard + API' },
  DASHBOARD_PASSWORD:{ required: false, desc: 'mot de passe Basic (sans lui, acces libre)' },
  DASHBOARD_DIR:     { required: false, desc: 'chemin du dashboard compile (defaut : dashboard/dist)' },
  DASHBOARD_ORIGIN:  { required: false, desc: 'origine autorisee en CORS — inutile si meme origine' },
  PORT:              { required: false, desc: 'port du service web (fourni par Railway)' },
  NODE_ENV:          { required: false, desc: 'development | production' },
  LOG_LEVEL:         { required: false, desc: 'debug | info | warn | error' }
}

export function loadEnv() {
  const missing = []
  const env = {}

  for (const [key, { required }] of Object.entries(SPEC)) {
    const v = process.env[key]
    if (!v && required) missing.push(key)
    env[key] = v ?? null
  }

  if (missing.length) {
    console.error('\nVariables d\'environnement manquantes :')
    for (const k of missing) console.error(`  ${k.padEnd(20)} ${SPEC[k].desc}`)
    console.error('\nLancer avec : node --env-file=.env <script>\n')
    process.exit(1)
  }

  return env
}

/** État des variables optionnelles, pour le rapport de démarrage. */
export function envStatus() {
  return Object.entries(SPEC).map(([key, s]) => ({
    key, desc: s.desc, required: s.required, present: Boolean(process.env[key])
  }))
}
