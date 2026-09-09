/**
 * Adapter Solana — contrôles de sécurité de base via RPC Helius.
 *
 * Les deux seuls contrôles que Mobula ne fournit pas (`security` est null sur
 * les tokens frais), et les moins chers du système : une lecture de compte.
 *
 * getMultipleAccounts accepte 100 adresses par appel → 600 tokens/jour = 6 appels.
 */

import { request } from '../../core/net/http.js'
import { mod } from '../../core/logger.js'

const log = mod('chain:solana')

export class SolanaAdapter {
  constructor({ apiKey } = {}) {
    this.family = 'solana'
    this.chain = 'solana'
    this.rpc = apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : null
    this.available = Boolean(this.rpc)
  }

  async #rpc(method, params) {
    const { json } = await request(this.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
    if (json.error) throw new Error(`RPC ${method} : ${json.error.message}`)
    return json.result
  }

  /**
   * Contrôles de sécurité pour N tokens en un appel.
   * @param {string[]} addresses
   * @returns {Promise<Map<string, SecurityResult>>}
   *   SecurityResult = { checked, passed, reason, details }
   */
  async checkBaseSecurityBatch(addresses) {
    const out = new Map()
    if (!this.available) {
      for (const a of addresses) {
        out.set(a, { checked: false, passed: true, reason: 'no_rpc', details: {} })
      }
      return out
    }

    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100)
      let accounts
      try {
        const res = await this.#rpc('getMultipleAccounts', [chunk, { encoding: 'jsonParsed' }])
        accounts = res?.value ?? []
      } catch (e) {
        log.warn({ size: chunk.length, err: e.message }, 'getMultipleAccounts en échec')
        // Échec technique : on NE valide pas par défaut, on marque non contrôlé.
        for (const a of chunk) {
          out.set(a, { checked: false, passed: true, reason: 'rpc_error', details: { err: e.message } })
        }
        continue
      }

      chunk.forEach((addr, k) => {
        out.set(addr, this.#interpret(accounts[k]))
      })
    }

    return out
  }

  async checkBaseSecurity(address) {
    return (await this.checkBaseSecurityBatch([address])).get(address)
  }

  #interpret(account) {
    const info = account?.data?.parsed?.info
    if (!info) {
      return { checked: false, passed: true, reason: 'account_not_found', details: {} }
    }

    const mintAuthority = info.mintAuthority ?? null
    const freezeAuthority = info.freezeAuthority ?? null

    const details = {
      mint_authority: mintAuthority,
      freeze_authority: freezeAuthority,
      supply: info.supply ?? null,
      decimals: info.decimals ?? null
    }

    // Le créateur ne doit pouvoir ni imprimer, ni geler les portefeuilles.
    if (mintAuthority) return { checked: true, passed: false, reason: 'mint_authority', details }
    if (freezeAuthority) return { checked: true, passed: false, reason: 'freeze_authority', details }

    return { checked: true, passed: true, reason: null, details }
  }

  /** Adresses à exclure du calcul du top 10 (pools, burn, programmes système). */
  isExcludedAddress(addr) {
    return EXCLUDED.has(addr)
  }

  normalizeAddress(a) { return a }
}

const EXCLUDED = new Set([
  '11111111111111111111111111111111',              // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',   // Token Program
  '1nc1nerator11111111111111111111111111111111'    // adresse de burn
])
