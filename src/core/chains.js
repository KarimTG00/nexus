/**
 * Registre des chaînes — correspondance entre nos identifiants internes
 * et ceux de Mobula, plus la famille d'adapter à utiliser.
 *
 * Ajouter une chaîne EVM = ajouter une ligne ici. Aucun code à écrire :
 * l'adapter EVM couvre toute la famille.
 */

// Identifiants Mobula vérifiés sur /api/1/system-metadata (100 chaînes déclarées).
// Le statut L1/L2 n'entre pas en ligne de compte : Base, Arbitrum et Robinhood Chain
// sont des L2, elles se traitent exactement comme les autres chaînes EVM.
export const CHAINS = {
  solana:    { mobula: 'solana:solana', dexscreener: 'solana',    family: 'solana', name: 'Solana',          native: 'SOL' },
  ethereum:  { mobula: 'evm:1',         dexscreener: 'ethereum',  family: 'evm',    name: 'Ethereum',        native: 'ETH' },
  base:      { mobula: 'evm:8453',      dexscreener: 'base',      family: 'evm',    name: 'Base',            native: 'ETH' },
  bnb:       { mobula: 'evm:56',        dexscreener: 'bsc',       family: 'evm',    name: 'BNB Smart Chain', native: 'BNB' },
  arbitrum:  { mobula: 'evm:42161',     dexscreener: 'arbitrum',  family: 'evm',    name: 'Arbitrum',        native: 'ETH' },
  robinhood: { mobula: 'evm:4663',      dexscreener: 'robinhood', family: 'evm',    name: 'Robinhood Chain', native: 'ETH' }
}

const BY_MOBULA = Object.fromEntries(
  Object.entries(CHAINS).map(([slug, c]) => [c.mobula, slug])
)

/** 'evm:8453' → 'base' */
export const fromMobula = id => BY_MOBULA[id] ?? null

/** 'base' → 'evm:8453' */
export const toMobula = slug => CHAINS[slug]?.mobula ?? null

export const family = slug => CHAINS[slug]?.family ?? null

/** 'bnb' -> 'bsc' (identifiants DexScreener) */
export const toDexscreener = slug => CHAINS[slug]?.dexscreener ?? null
export const fromDexscreener = id =>
  Object.entries(CHAINS).find(([, c]) => c.dexscreener === id)?.[0] ?? null

/** Identifiant interne d'un token : "base:0xabc…" */
export const tokenId = (chain, address) => `${chain}:${address}`

/** Décompose "base:0xabc…" */
export function parseTokenId(id) {
  const i = id.indexOf(':')
  return { chain: id.slice(0, i), address: id.slice(i + 1) }
}

/** Normalise une adresse selon la famille de chaîne. */
export function normalizeAddress(chain, address) {
  if (!address) return null
  return family(chain) === 'evm' ? address.toLowerCase() : address
}

export const isKnownChain = slug => slug in CHAINS
