/**
 * Interface DataSource — contrat que toute source de données doit respecter.
 *
 * Règle d'architecture : le pipeline n'importe JAMAIS un adapter concret.
 * Il ne connaît que cette interface. C'est ce qui rend une source remplaçable
 * si Mobula déçoit ou change.
 *
 * Chaque source déclare ses `capabilities` : le pipeline s'adapte au lieu de planter.
 */

export const CAP = {
  LISTINGS:     'listings',       // flux de nouveaux tokens
  MARKET_BATCH: 'market_batch',   // prix/MC de N tokens en un appel
  POOLS:        'pools',          // tous les pools d'un token
  VELOCITY:     'velocity',       // acheteurs/vendeurs/traders uniques par fenêtre
  HOLDERS:      'holders',        // nombre de détenteurs
  TOP_GAINERS:  'top_gainers'     // meilleures performances (watchdog M7)
}

/**
 * @typedef {Object} TokenRef
 * @property {string} _id      "{chain}:{address}"
 * @property {string} chain
 * @property {string} address
 */

/**
 * @typedef {Object} Velocity   Métriques d'une fenêtre temporelle
 * @property {number} buyers    acheteurs uniques
 * @property {number} sellers   vendeurs uniques
 * @property {number} traders   traders uniques
 * @property {number} buys
 * @property {number} sells
 * @property {number} trades
 * @property {number} volumeUsd
 */

/**
 * @typedef {Object} Listing    Un token fraîchement découvert, normalisé
 * @property {string} _id
 * @property {string} chain
 * @property {string} address
 * @property {string|null} symbol
 * @property {string|null} name
 * @property {number|null} decimals
 * @property {string|null} deployer
 * @property {string|null} launchpad
 * @property {Date|null}   createdAt
 * @property {'new'|'bonding'|'bonded'} bucket
 * @property {Object} pool      {address, dex, quote, liquidityUsd, createdAt}
 * @property {Object} market    {mc, price, liquidityUsd, volume24h}
 * @property {Object<string,Velocity>} velocity  par fenêtre : '1min','5min','15min','1h'…
 * @property {Object} holders   {count, top10Pct, devPct, insidersPct, snipersPct, bundlersPct, proTradersPct}
 * @property {Object} bonding   {bonded, percentage}
 * @property {Object} candidates métriques brutes de la source, à évaluer par M6
 */

/**
 * @typedef {Object} MarketData
 * @property {string} _id
 * @property {number|null} mc
 * @property {number|null} price
 * @property {number|null} liquidityUsd
 * @property {number|null} volume24h
 * @property {number|null} supply
 */

/**
 * Contrat attendu (documentaire — JS n'a pas d'interfaces) :
 *
 *   capabilities: Set<string>
 *   getNewListings(chains: string[]): Promise<Listing[]>
 *   getMarketData(refs: TokenRef[]): Promise<Map<string, MarketData>>
 *   getTokenMarkets(ref: TokenRef): Promise<{ pools, aggregated, candidates }>
 *   getTopGainers(period: string, limit: number): Promise<TokenRef[]>
 */

export function assertCapability(source, cap) {
  if (!source.capabilities.has(cap)) {
    throw new Error(`La source « ${source.name} » ne fournit pas « ${cap} »`)
  }
}

export function hasCapability(source, cap) {
  return source.capabilities.has(cap)
}

/** Fenêtres temporelles que l'on normalise (celles réellement exploitées). */
export const WINDOWS = ['1min', '5min', '15min', '1h', '24h']
