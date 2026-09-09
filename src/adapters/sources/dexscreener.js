/**
 * Source de données DexScreener — secondaire.
 *
 * Rôle : combler l'instabilité de `token/markets` chez Mobula, qui a renvoyé
 * 25, 16, 3, 4 puis 0 pools sur des appels identiques. DexScreener a répondu
 * de façon fiable à chaque appel de nos tests.
 *
 * Gratuite, sans clé. Couvre Robinhood Chain (`chainId: robinhood`).
 *
 * Limite mesurée : la réponse est plafonnée à 30 PAIRES au total, pas
 * 30 tokens — un token très liquide consomme le quota à lui seul. Elle sert
 * donc pour un token à la fois, jamais pour du lot : c'est Mobula qui garde
 * le lot (50 tokens pour 1 crédit).
 */

import { request } from '../../core/net/http.js'
import { RateLimiter } from '../../core/net/rate-limiter.js'
import { CAP, WINDOWS } from '../../core/types/datasource.js'
import { toDexscreener, tokenId, normalizeAddress } from '../../core/chains.js'
import { mod } from '../../core/logger.js'

const log = mod('dexscreener')
const BASE = 'https://api.dexscreener.com/latest/dex'

/** Correspondance entre nos fenêtres et celles de DexScreener. */
const WINDOW_MAP = { '5min': 'm5', '1h': 'h1', '24h': 'h24' }

export class DexscreenerSource {
  constructor({ dailyBudget = 20_000 } = {}) {
    this.name = 'dexscreener'
    this.failures = []
    // Pas de quota facturé, mais un débit à respecter (~300 req/min annoncés).
    this.limiter = new RateLimiter('dexscreener', {
      dailyBudget, minIntervalMs: 250, concurrency: 2
    })

    this.capabilities = new Set([CAP.POOLS, CAP.VELOCITY])
    // Volontairement PAS MARKET_BATCH : le plafond de 30 paires rend le lot
    // non fiable. Mobula reste la source du lot.
  }

  async #get(path) {
    return this.limiter.run(() => request(BASE + path, { retries: 2 }))
  }

  /**
   * Tous les pools d'un token, avec liquidité par pool et agrégat.
   * Même forme de retour que MobulaSource.getTokenMarkets — c'est le contrat.
   */
  async getTokenMarkets(ref) {
    const dsChain = toDexscreener(ref.chain)
    let res
    try {
      res = await this.#get(`/tokens/${encodeURIComponent(ref.address)}`)
    } catch (e) {
      this.failures.push({ op: 'getTokenMarkets', ref: ref.address, err: e.message })
      return { pools: [], aggregated: emptyAggregate(), source: this.name }
    }

    // La réponse mélange les chaînes : on ne garde que celle demandée.
    const pairs = (res.json?.pairs ?? []).filter(p => !dsChain || p.chainId === dsChain)

    const pools = pairs.map(p => ({
      address: p.pairAddress,
      dex: p.dexId ?? null,
      quote: p.quoteToken?.symbol ?? null,
      liquidityUsd: num(p.liquidity?.usd),
      liquidityBurnPct: null,          // non fourni par DexScreener
      createdAt: p.pairCreatedAt ? new Date(p.pairCreatedAt) : null,
      bonded: null,
      bondingPct: null,
      priceUsd: num(p.priceUsd),
      velocity: readWindows(p)
    }))

    // Dédoublonnage par adresse de pool — l'API peut répéter une paire.
    const seen = new Set()
    const unique = pools.filter(p => {
      const a = String(p.address).toLowerCase()
      if (seen.has(a)) return false
      seen.add(a)
      return true
    })

    const active = unique.filter(p => (p.liquidityUsd ?? 0) > 0)
    const total = active.reduce((s, p) => s + (p.liquidityUsd ?? 0), 0)
    const primary = active.slice().sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0] ?? null

    const first = pairs[0]
    return {
      pools: unique,
      aggregated: {
        liquidityUsd: total,
        poolCount: unique.length,
        activePoolCount: active.length,
        primaryPool: primary?.address ?? null,
        primaryShare: primary && total ? primary.liquidityUsd / total : null,
        liquidityBurnPct: null,
        velocity: mergeWindows(active.map(p => p.velocity)),
        // Bonus : DexScreener fournit aussi MC et FDV, utiles en recoupement
        mc: num(first?.marketCap),
        fdv: num(first?.fdv),
        priceUsd: num(first?.priceUsd)
      },
      source: this.name
    }
  }

  async stats() {
    return { ...(await this.limiter.stats()), failures: this.failures.length }
  }

  drainFailures() { const f = this.failures; this.failures = []; return f }
}

// --- helpers ---------------------------------------------------------------

const num = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v))

/**
 * DexScreener donne des COMPTES de transactions (buys/sells), pas des wallets
 * uniques. `buyers`/`sellers`/`traders` restent donc null : on ne fabrique pas
 * une donnée qu'on n'a pas — Mobula reste seul à fournir les acheteurs uniques.
 */
function readWindows(pair) {
  const out = {}
  for (const w of WINDOWS) {
    const k = WINDOW_MAP[w]
    if (!k) { out[w] = emptyWindow(); continue }
    const t = pair.txns?.[k] ?? {}
    const buys = num(t.buys)
    const sells = num(t.sells)
    out[w] = {
      buyers: null, sellers: null, traders: null,
      buys, sells,
      trades: buys !== null && sells !== null ? buys + sells : null,
      volumeUsd: num(pair.volume?.[k])
    }
  }
  return out
}

const emptyWindow = () => ({
  buyers: null, sellers: null, traders: null,
  buys: null, sells: null, trades: null, volumeUsd: null
})

const emptyAggregate = () => ({
  liquidityUsd: null, poolCount: 0, activePoolCount: 0,
  primaryPool: null, primaryShare: null, liquidityBurnPct: null,
  velocity: {}, mc: null, fdv: null, priceUsd: null
})

function mergeWindows(list) {
  if (!list.length) return {}
  const out = {}
  for (const w of WINDOWS) {
    out[w] = {}
    for (const f of ['buyers', 'sellers', 'traders', 'buys', 'sells', 'trades', 'volumeUsd']) {
      const vals = list.map(v => v?.[w]?.[f]).filter(x => x !== null && x !== undefined)
      out[w][f] = vals.length ? vals.reduce((a, b) => a + b, 0) : null
    }
  }
  return out
}
