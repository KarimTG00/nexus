/**
 * Registre des fournisseurs RPC Solana.
 *
 * Le collecteur ne dépend plus d'un fournisseur unique : `parse-rpc.js`
 * reconstruit un swap depuis du Solana brut, donc n'importe quel nœud fait
 * l'affaire. Ce registre existe pour qu'ajouter un fournisseur soit une entrée
 * de tableau, jamais une modification du collecteur.
 *
 * Deux raisons de les cumuler :
 *   - le quota : trois offres gratuites valent mieux qu'une
 *   - la disponibilité : Helius épuisé a arrêté la collecte net, sans repli
 *
 * ⚠️ Les « crédits » ne sont PAS la même unité d'un fournisseur à l'autre. Un
 * `getTransaction` ne coûte pas le même nombre d'unités chez Alchemy, QuickNode
 * et Ankr, et les messages WebSocket suivent encore d'autres règles. Les
 * chiffres annoncés sur les pages tarifaires ne sont donc pas comparables
 * entre eux : `cost_unit` rappelle laquelle chacun emploie, et seule une
 * mesure réelle dit ce qu'un mois de collecte consomme.
 */

export const PROVIDERS = {
  alchemy: {
    nom: 'Alchemy',
    envKey: 'ALCHEMY_KEY',
    cost_unit: 'compute units',
    http: k => `https://solana-mainnet.g.alchemy.com/v2/${k}`,
    ws: k => `wss://solana-mainnet.g.alchemy.com/v2/${k}`
  },
  quicknode: {
    nom: 'QuickNode',
    envKey: 'QUICKNODE_URL',
    cost_unit: 'API credits',
    // QuickNode fournit une URL complète et unique par point d'accès, clé
    // comprise — d'où une variable qui porte l'URL et non une clé.
    http: u => u,
    ws: u => String(u).replace(/^http/, 'ws')
  },
  ankr: {
    nom: 'Ankr',
    envKey: 'ANKR_KEY',
    cost_unit: 'requests',
    http: k => `https://rpc.ankr.com/solana/${k}`,
    ws: k => `wss://rpc.ankr.com/solana/ws/${k}`
  },
  // Repli sans clé : utile pour un contrôle ponctuel, inutilisable en continu
  // (cadence très limitée, pas de WebSocket public fiable).
  public: {
    nom: 'RPC public',
    envKey: null,
    cost_unit: null,
    http: () => 'https://api.mainnet-beta.solana.com',
    ws: () => 'wss://api.mainnet-beta.solana.com'
  }
}

/** Fournisseurs réellement utilisables, dans l'ordre de préférence. */
export function disponibles() {
  return Object.entries(PROVIDERS)
    .filter(([id, p]) => id !== 'public' && p.envKey && process.env[p.envKey])
    .map(([id, p]) => ({ id, ...p, secret: process.env[p.envKey] }))
}

/**
 * Un fournisseur par son identifiant, ou le premier disponible.
 * @returns {{id, nom, httpUrl, wsUrl, cost_unit}|null}
 */
export function fournisseur(id = null) {
  const p = id ? PROVIDERS[id] : null
  if (id && !p) throw new Error(`fournisseur inconnu : ${id}`)

  if (p) {
    const secret = p.envKey ? process.env[p.envKey] : null
    if (p.envKey && !secret) return null
    return { id, nom: p.nom, cost_unit: p.cost_unit, httpUrl: p.http(secret), wsUrl: p.ws(secret) }
  }

  const dispo = disponibles()[0]
  if (!dispo) return null
  return {
    id: dispo.id, nom: dispo.nom, cost_unit: dispo.cost_unit,
    httpUrl: dispo.http(dispo.secret), wsUrl: dispo.ws(dispo.secret)
  }
}

/** Le repli public, explicitement demandé — jamais choisi par défaut. */
export function publicRpc() {
  return {
    id: 'public', nom: PROVIDERS.public.nom, cost_unit: null,
    httpUrl: PROVIDERS.public.http(), wsUrl: PROVIDERS.public.ws()
  }
}
