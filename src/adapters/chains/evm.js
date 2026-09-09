/**
 * Adapter EVM — un seul code pour Base, BNB, Robinhood Chain et toute chaîne
 * EVM ajoutée par configuration.
 *
 * Choix de méthode : analyse du BYTECODE plutôt qu'une API de sécurité tierce.
 * Raison : GoPlus & co. ne couvrent pas les chaînes récentes — Robinhood Chain
 * en particulier, qui est l'une de nos plus productives. Lire le bytecode
 * fonctionne partout où il y a un RPC, sans dépendance externe.
 *
 * Limite assumée : on détecte la PRÉSENCE de fonctions dangereuses, pas leur
 * atteignabilité réelle. Un contrat proxy peut masquer son implémentation.
 * D'où le champ `checked` : on ne prétend jamais avoir validé ce qu'on n'a pas pu lire.
 */

import { createPublicClient, http as viemHttp, toFunctionSelector, getAddress } from 'viem'
import { mod } from '../../core/logger.js'

const log = mod('chain:evm')

// Sélecteurs calculés au démarrage — pas de constantes devinées.
const SEL = Object.fromEntries(
  ['mint(address,uint256)', 'mint(uint256)', 'pause()', 'blacklist(address)',
   'setBlacklist(address,bool)', 'owner()', 'renounceOwnership()',
   'setFees(uint256,uint256)', 'setTaxes(uint256,uint256)']
    .map(sig => [sig, toFunctionSelector(sig).slice(2)])
)

const DANGEROUS = {
  mint:      ['mint(address,uint256)', 'mint(uint256)'],
  pause:     ['pause()'],
  blacklist: ['blacklist(address)', 'setBlacklist(address,bool)'],
  fees:      ['setFees(uint256,uint256)', 'setTaxes(uint256,uint256)']
}

const ZERO = '0x0000000000000000000000000000000000000000'
const DEAD = '0x000000000000000000000000000000000000dead'

/** RPC publics par défaut, surchargeables par RPC_<CHAIN> dans .env */
const DEFAULT_RPC = {
  base: 'https://mainnet.base.org',
  bnb: 'https://bsc-dataseed.binance.org',
  ethereum: 'https://eth.llamarpc.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  // RPC public officiel, sans clé — limité en débit, sans garantie de service.
  // À remplacer par un fournisseur dédié (RPC_ROBINHOOD) si le throttling gêne.
  robinhood: 'https://rpc.mainnet.chain.robinhood.com'
}

export class EvmAdapter {
  constructor(chain, { rpcUrl } = {}) {
    this.family = 'evm'
    this.chain = chain
    this.rpcUrl = rpcUrl
      ?? process.env[`RPC_${chain.toUpperCase()}`]
      ?? DEFAULT_RPC[chain]
      ?? null
    this.available = Boolean(this.rpcUrl)
    this.client = this.available
      ? createPublicClient({ transport: viemHttp(this.rpcUrl, { timeout: 15_000, retryCount: 2 }) })
      : null

    if (!this.available) {
      log.warn({ chain }, 'aucun RPC configuré — sécurité non contrôlée sur cette chaîne')
    }
  }

  async checkBaseSecurityBatch(addresses) {
    const out = new Map()
    // Pas de getMultipleAccounts en EVM : une requête par contrat, en parallèle borné.
    const CONC = 5
    for (let i = 0; i < addresses.length; i += CONC) {
      const chunk = addresses.slice(i, i + CONC)
      const results = await Promise.all(chunk.map(a => this.checkBaseSecurity(a)))
      chunk.forEach((a, k) => out.set(a, results[k]))
    }
    return out
  }

  async checkBaseSecurity(address) {
    if (!this.available) {
      return { checked: false, passed: true, reason: 'no_rpc', details: { chain: this.chain } }
    }

    let code
    try {
      code = await this.client.getCode({ address: getAddress(address) })
    } catch (e) {
      return { checked: false, passed: true, reason: 'rpc_error', details: { err: e.message } }
    }

    if (!code || code === '0x') {
      return { checked: true, passed: false, reason: 'not_a_contract', details: {} }
    }

    const hex = code.slice(2).toLowerCase()
    const found = {}
    for (const [label, sigs] of Object.entries(DANGEROUS)) {
      found[label] = sigs.some(s => hex.includes(SEL[s]))
    }

    // Propriété renoncée ? Seulement si le contrat expose owner().
    let owner = null
    let ownershipRenounced = null
    if (hex.includes(SEL['owner()'])) {
      try {
        const r = await this.client.call({
          to: getAddress(address),
          data: toFunctionSelector('owner()')
        })
        if (r?.data && r.data.length >= 66) {
          owner = '0x' + r.data.slice(-40)
          ownershipRenounced = owner === ZERO || owner === DEAD
        }
      } catch { /* pas d'owner() exploitable */ }
    } else {
      ownershipRenounced = true   // aucune notion de propriétaire
    }

    const details = {
      ownership_renounced: ownershipRenounced,
      owner,
      has_mint: found.mint,
      has_pause: found.pause,
      has_blacklist: found.blacklist,
      has_fee_setter: found.fees,
      bytecode_size: hex.length / 2
    }

    // Équivalents EVM de mint/freeze authority : dangereux uniquement si un
    // propriétaire subsiste pour les appeler.
    if (ownershipRenounced === false) {
      if (found.mint)      return { checked: true, passed: false, reason: 'mint_authority', details }
      if (found.blacklist) return { checked: true, passed: false, reason: 'freeze_authority', details }
      if (found.pause)     return { checked: true, passed: false, reason: 'freeze_authority', details }
    }

    return { checked: true, passed: true, reason: null, details }
  }

  isExcludedAddress(addr) {
    const a = String(addr).toLowerCase()
    return a === ZERO || a === DEAD
  }

  normalizeAddress(a) { return String(a).toLowerCase() }
}
