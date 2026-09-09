/**
 * Registre des adapters de chaîne.
 * Deux implémentations couvrent toutes les chaînes : Solana, et EVM (N chaînes).
 */

import { SolanaAdapter } from './solana.js'
import { EvmAdapter } from './evm.js'
import { family, CHAINS } from '../../core/chains.js'
import { mod } from '../../core/logger.js'

const log = mod('chains')
const cache = new Map()

export function getAdapter(chain) {
  if (cache.has(chain)) return cache.get(chain)
  if (!CHAINS[chain]) throw new Error(`Chaîne inconnue : ${chain}`)

  const adapter = family(chain) === 'solana'
    ? new SolanaAdapter({ apiKey: process.env.HELIUS_KEY })
    : new EvmAdapter(chain)

  cache.set(chain, adapter)
  return adapter
}

/** Rapport de disponibilité des contrôles de sécurité, par chaîne. */
export function adapterStatus(chains) {
  return chains.map(c => {
    const a = getAdapter(c)
    return { chain: c, family: a.family, securityAvailable: a.available }
  })
}

export function resetAdapters() { cache.clear() }
