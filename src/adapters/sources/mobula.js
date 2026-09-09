/**
 * Source de données Mobula.
 *
 * Ne jamais laisser fuiter la forme Mobula hors de ce fichier : tout sort
 * normalisé selon les types de core/types/datasource.js.
 *
 * Constats du POC (docs/poc-mobula-rapport.md) :
 *   - `chainId` est OBLIGATOIRE sur Pulse, sinon réponse vide
 *   - Pulse renvoie 3 buckets : new / bonding / bonded
 *   - les buckets reviennent parfois VIDES de façon intermittente → fusion sur N cycles
 *   - multi-data accepte 50 tokens pour 1 crédit
 *   - multi-data ne contient AUCUN champ de vélocité
 *   - token/markets fournit vélocité + liquidityBurnPercentage, 1 token par appel
 */

import { request } from '../../core/net/http.js'
import { RateLimiter } from '../../core/net/rate-limiter.js'
import { CAP, WINDOWS } from '../../core/types/datasource.js'
import { toMobula, fromMobula, tokenId, normalizeAddress } from '../../core/chains.js'
import { mod } from '../../core/logger.js'

const log = mod('mobula')
const BASE = 'https://api.mobula.io'

export class MobulaSource {
  constructor({ apiKey, dailyBudget = 8000, batchSize = 50, mergeCycles = 3 } = {}) {
    if (!apiKey) throw new Error('MobulaSource : clé API manquante')
    this.name = 'mobula'
    this.apiKey = apiKey
    this.batchSize = batchSize
    this.mergeCycles = mergeCycles
    this.limiter = new RateLimiter('mobula', { dailyBudget })
    this.failures = []   // défaillances tolérées, mais jamais effacées

    this.capabilities = new Set([
      CAP.LISTINGS, CAP.MARKET_BATCH, CAP.POOLS, CAP.VELOCITY, CAP.HOLDERS
      // CAP.TOP_GAINERS : aucun endpoint confirmé — le watchdog M7 utilisera une autre source
    ])
  }

  async #get(path, cost = 1) {
    return this.limiter.run(
      () => request(BASE + path, { headers: { Authorization: this.apiKey } }),
      cost
    )
  }

  // -------------------------------------------------------------------------
  // Découverte
  // -------------------------------------------------------------------------

  /**
   * Nouveaux tokens sur les chaînes demandées.
   * Les buckets Pulse revenant parfois vides, on réessaie et on fusionne.
   * @param {string[]} chains  slugs internes ('solana', 'base'…)
   * @returns {Promise<Listing[]>}
   */
  /**
   * PAGINATION ADAPTATIVE — mesuré : le plafond réel d'un bucket est de 50
   * éléments, pas 100 (le paramètre `limit` n'y change rien). Sur Solana,
   * 110 tokens naissent en 5 minutes : sans pagination on en perdait plus de
   * la moitié, définitivement, puisque la fenêtre Pulse ne remonte qu'à ~3 h.
   *
   * On avance page par page tant qu'une page apporte des tokens inconnus,
   * et on s'arrête dès qu'elle n'apporte plus rien. Les chaînes actives
   * paginent en profondeur, les calmes s'arrêtent à la première page —
   * aucun réglage par chaîne à maintenir.
   */
  /**
   * Découverte par POST /api/2/pulse — la voie efficace.
   *
   * Mesuré :
   *   - jusqu'à 10 « vues » par requête, pour 1 SEUL crédit
   *   - filtrage côté serveur (liquidity, holders, top10, bundlers…)
   *   - 4 chaînes × 3 modèles = 12 vues → 2 requêtes → 2 crédits/cycle,
   *     contre 14 avec la pagination GET
   *
   * ⚠️ Le plancher de liquidité envoyé au serveur est délibérément TRÈS BAS,
   * bien en dessous du seuil d'admission. Filtrer au seuil réel nous rendrait
   * aveugles à ce qu'on écarte : `rejected_seen` ne verrait plus rien, M5 ne
   * pourrait plus balayer le seuil, et la seconde chance n'aurait plus de
   * candidats. On n'écarte au serveur que ce qu'on ne considérerait jamais.
   */
  async getNewListingsPost(chains, { serverLiquidityFloor = 500, perView = 50, pages = 1 } = {}) {
    const MODELS = ['new', 'bonding', 'bonded']
    const MAX_VIEWS = 10          // imposé par l'API : « at most 10 element(s) »

    const views = []
    for (const chain of chains) {
      const mobulaId = toMobula(chain)
      if (!mobulaId) continue
      for (const model of MODELS) {
        for (let p = 0; p < pages; p++) {
          views.push({
            name: `${chain}|${model}|${p}`,
            model,
            chainId: [mobulaId],
            limit: perView,
            offset: p * perView,
            sortBy: 'created_at',
            sortOrder: 'desc',
            filters: { liquidity: { gte: serverLiquidityFloor } }
          })
        }
      }
    }

    const merged = new Map()
    const perChain = {}
    let requests = 0

    for (let i = 0; i < views.length; i += MAX_VIEWS) {
      const chunk = views.slice(i, i + MAX_VIEWS)
      let res
      try {
        // Une requête de 10 vues répond en ~10 s : marge large, et peu de
        // réessais — un timeout trop court déclenchait des relances inutiles
        // qui triplaient la durée du cycle.
        res = await this.limiter.run(() => request(`${BASE}/api/2/pulse`, {
          method: 'POST',
          headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ views: chunk }),
          timeoutMs: 90_000,
          retries: 1
        }))
        requests++
      } catch (e) {
        this.failures.push({ op: 'getNewListingsPost', views: chunk.length, err: e.message })
        log.warn({ views: chunk.length, err: e.message }, 'Pulse POST en échec')
        continue
      }

      for (const [viewName, payload] of Object.entries(res.json ?? {})) {
        const [chain, model] = viewName.split('|')
        for (const item of payload?.data ?? []) {
          const listing = this.#normalizeListing(item, chain, model)
          if (!listing || merged.has(listing._id)) continue
          merged.set(listing._id, listing)
          perChain[chain] = (perChain[chain] ?? 0) + 1
        }
      }
    }

    log.info({ tokens: merged.size, requetes: requests, vues: views.length, chaines: perChain },
      'découverte (POST)')
    return [...merged.values()]
  }

  /** Voie GET paginée — repli si le POST échoue. */
  async getNewListings(chains, { pageSize = 100, maxPages = 4, freshMinutes = 10 } = {}) {
    const merged = new Map()
    const perChain = {}
    const now = Date.now()

    for (const chain of chains) {
      const mobulaId = toMobula(chain)
      if (!mobulaId) { log.warn({ chain }, 'chaîne inconnue, ignorée'); continue }

      let pages = 0
      let sansFrais = 0
      let ajoutesChaine = 0
      let fraisChaine = 0

      for (let page = 0; page < maxPages; page++) {
        let res
        try {
          res = await this.#get(`/api/2/pulse?limit=${pageSize}`
            + `&offset=${page * pageSize}`
            + `&chainId=${encodeURIComponent(mobulaId)}`)
        } catch (e) {
          this.failures.push({ op: 'getNewListings', chain, page, err: e.message })
          log.warn({ chain, page, err: e.message }, 'Pulse en échec')
          break
        }
        pages++

        let ajoutes = 0
        let frais = 0
        for (const bucket of ['new', 'bonding', 'bonded']) {
          for (const item of res.json?.[bucket]?.data ?? []) {
            const listing = this.#normalizeListing(item, chain, bucket)
            if (!listing || merged.has(listing._id)) continue
            merged.set(listing._id, listing)
            ajoutes++
            if (listing.createdAt && (now - listing.createdAt) / 60_000 < freshMinutes) frais++
          }
        }
        ajoutesChaine += ajoutes
        fraisChaine += frais

        // Critère d'arrêt aligné sur l'objectif : on pagine pour rattraper les
        // lancements RÉCENTS. Mesuré, les pages profondes ne ramènent que des
        // tokens anciens, issus du backlog des buckets bonding/bonded — or
        // ceux-là reviendront aux cycles suivants (fenêtre bonded ~3 h).
        // On tolère une page sans frais (buckets vides par intermittence),
        // deux d'affilée signent la fin de la zone utile.
        if (frais === 0) {
          if (++sansFrais >= 2) break
        } else {
          sansFrais = 0
        }
      }

      perChain[chain] = { pages, tokens: ajoutesChaine, frais: fraisChaine }
    }

    log.info({ tokens: merged.size, chaines: perChain }, 'découverte')
    return [...merged.values()]
  }

  /** Item Pulse → Listing normalisé. */
  #normalizeListing(item, chain, bucket) {
    const pair = item.pair
    if (!pair) return null

    // baseToken/quoteToken sont des POINTEURS : "token0" ou "token1"
    const base = pair[pair.baseToken]
    const quote = pair[pair.quoteToken]
    if (!base?.address) return null

    const address = normalizeAddress(chain, base.address)

    return {
      _id: tokenId(chain, address),
      chain,
      address,
      symbol: base.symbol ?? item.tokenSymbol ?? null,
      name: base.name ?? item.tokenName ?? null,
      decimals: base.decimals ?? null,
      deployer: item.deployer ?? null,
      launchpad: pair.exchange?.name ?? pair.type ?? item.source ?? null,
      createdAt: pair.createdAt ? new Date(pair.createdAt) : null,
      bucket,

      pool: {
        address: pair.address,
        dex: pair.type ?? pair.exchange?.name ?? null,
        quote: quote?.symbol ?? null,
        liquidityUsd: num(pair.liquidity ?? item.liquidity),
        createdAt: pair.createdAt ? new Date(pair.createdAt) : null
      },

      market: {
        mc: num(item.market_cap ?? base.marketCap),
        price: num(item.price ?? base.price),
        liquidityUsd: num(pair.liquidity ?? item.liquidity),
        volume24h: num(item.volume_24h ?? pair.volume24h)
      },

      velocity: readWindows(item, 'snake'),

      holders: {
        count: num(item.holders_count),
        top10Pct: num(item.top10HoldingsPercentage),
        devPct: num(item.devHoldingsPercentage)
      },

      bonding: {
        bonded: Boolean(item.bonded),
        percentage: num(item.bondingPercentage)
      },

      socials: item.socials ?? null,

      // Signaux propriétaires Mobula : enregistrés comme métriques candidates,
      // évalués par M6. Méthodologie opaque → on mesure, on ne suppose pas.
      candidates: {
        mobula_insiders_pct: num(item.insidersHoldingsPercentage),
        mobula_snipers_pct: num(item.snipersHoldingsPercentage),
        mobula_bundlers_pct: num(item.bundlersHoldingsPercentage),
        mobula_pro_traders: num(item.proTradersHolding),
        mobula_deployer_migrations: num(item.deployerMigrations),
        mobula_twitter_reuses: num(item.twitterReusesCount),
        mobula_security_score: num(item.securityScore),
        mobula_dexscreener_listed: item.dexscreenerListed ?? null,
        top50_pct: num(item.top50HoldingsPercentage),
        top100_pct: num(item.top100HoldingsPercentage)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Données de marché par lot — 50 tokens pour 1 crédit
  // -------------------------------------------------------------------------

  /**
   * @param {TokenRef[]} refs
   * @returns {Promise<Map<string, MarketData>>}  clé = _id interne
   */
  async getMarketData(refs) {
    const out = new Map()
    if (!refs.length) return out

    // Groupé par chaîne : `blockchain` lève l'ambiguïté entre chaînes
    const byChain = new Map()
    for (const r of refs) {
      if (!byChain.has(r.chain)) byChain.set(r.chain, [])
      byChain.get(r.chain).push(r)
    }

    for (const [chain, list] of byChain) {
      const mobulaId = toMobula(chain)

      for (let i = 0; i < list.length; i += this.batchSize) {
        const chunk = list.slice(i, i + this.batchSize)
        const assets = chunk.map(r => r.address).join(',')
        const url = `/api/1/market/multi-data?assets=${encodeURIComponent(assets)}`
          + (mobulaId ? `&blockchain=${encodeURIComponent(mobulaId)}` : '')

        let res
        try {
          res = await this.#get(url)
        } catch (e) {
          // On tolère un lot manqué (le token sera revu au cycle suivant), mais
          // on ne l'efface PAS : un échec silencieux fausserait toute validation.
          this.failures.push({ op: 'getMarketData', chain, size: chunk.length, err: e.message })
          log.warn({ chain, size: chunk.length, err: e.message }, 'lot en échec')
          continue
        }

        for (const [addr, d] of Object.entries(res.json?.data ?? {})) {
          if (!d) continue
          const address = normalizeAddress(chain, addr)

          // Lien entre homologues multichain.
          // `market_cap` est AGRÉGÉ sur toutes les chaînes (vérifié : USDC renvoie
          // 74,2 Md sur Solana comme sur Base) tandis que `liquidity` est locale.
          // C'est voulu et conservé : un token listé partout voit son prix influencé
          // par les échanges de toutes ses chaînes — le MC agrégé EST sa vraie
          // valorisation. On enregistre le lien pour ne pas alerter N fois.
          const contracts = Array.isArray(d.contracts) ? d.contracts : []

          out.set(tokenId(chain, address), {
            _id: tokenId(chain, address),
            chain,
            address,
            symbol: d.symbol ?? null,
            mc: num(d.market_cap),              // agrégé multichain — assumé
            price: num(d.price),
            liquidityUsd: num(d.liquidity),     // locale à la chaîne
            volume24h: num(d.volume),
            supply: num(d.circulating_supply ?? d.total_supply),
            priceChange24h: num(d.price_change_24h),

            assetId: d.id ?? null,
            contractsCount: contracts.length,
            isMultichain: contracts.length > 1,
            deployments: contracts.map(c => ({
              address: normalizeAddress(fromMobulaBlockchainId(c.blockchainId), c.address),
              chainId: c.blockchainId ?? null,
              chainName: c.blockchain ?? null
            }))
          })
        }
      }
    }

    return out
  }

  // -------------------------------------------------------------------------
  // Pools et vélocité d'un token — 1 crédit, couvre 5 contrôles de l'étage 5
  // -------------------------------------------------------------------------

  async getTokenMarkets(ref, { limit = 25 } = {}) {
    const mobulaId = toMobula(ref.chain)
    const res = await this.#get(
      `/api/2/token/markets?blockchain=${encodeURIComponent(mobulaId)}`
      + `&address=${encodeURIComponent(ref.address)}&limit=${limit}`)

    const d = res.json?.data ?? res.json
    const raw = d?.markets ?? d?.data ?? (Array.isArray(d) ? d : [])

    const pools = raw.map(m => ({
      address: m.address,
      dex: m.type ?? m.exchange?.name ?? null,
      quote: m.quoteToken?.symbol ?? null,
      liquidityUsd: num(m.liquidityUSD),
      liquidityBurnPct: num(m.liquidityBurnPercentage),
      createdAt: m.createdAt ? new Date(m.createdAt) : null,
      bonded: Boolean(m.bonded),
      bondingPct: num(m.bondingPercentage),
      priceUsd: num(m.priceUSD),
      velocity: readWindows(m, 'camel')
    }))

    // Agrégation sur tous les pools actifs : traite la fragmentation nativement
    const active = pools.filter(p => (p.liquidityUsd ?? 0) > 0)
    const primary = active.slice().sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0] ?? null

    const aggregated = {
      liquidityUsd: sum(active, p => p.liquidityUsd),
      poolCount: pools.length,
      activePoolCount: active.length,
      primaryPool: primary?.address ?? null,
      // Part du pool principal : < 70 % = liquidité fragmentée
      primaryShare: primary && sum(active, p => p.liquidityUsd)
        ? primary.liquidityUsd / sum(active, p => p.liquidityUsd) : null,
      liquidityBurnPct: primary?.liquidityBurnPct ?? null,
      velocity: mergeWindows(active.map(p => p.velocity))
    }

    return { pools, aggregated }
  }

  // -------------------------------------------------------------------------

  async stats() {
    return { ...(await this.limiter.stats()), failures: this.failures.length }
  }

  /** Vide et renvoie les défaillances accumulées. */
  drainFailures() { const f = this.failures; this.failures = []; return f }
}

// --- helpers ---------------------------------------------------------------

const num = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v))
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) ?? 0), 0)

/**
 * Mobula utilise deux conventions de nommage selon l'endpoint :
 *   Pulse           : buyers_5min, buys_5min, volume_5min       (snake)
 *   token/markets   : buyers5min,  buys5min,  volume5minUSD     (camel)
 */
function readWindows(obj, style) {
  const out = {}
  for (const w of WINDOWS) {
    const k = style === 'snake'
      ? f => `${f}_${w}`
      : f => (f === 'volume' ? `volume${w}USD` : `${f}${w}`)

    out[w] = {
      buyers: num(obj[k('buyers')]),
      sellers: num(obj[k('sellers')]),
      traders: num(obj[k('traders')]),
      buys: num(obj[k('buys')]),
      sells: num(obj[k('sells')]),
      trades: num(obj[k('trades')]),
      volumeUsd: num(obj[k('volume')])
    }
  }
  return out
}

/** Somme les fenêtres de plusieurs pools (agrégation multi-pools). */
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

/**
 * `contracts[].blockchainId` de Mobula est brut : "solana", "8453", "56"…
 * (pas le format "evm:8453" du reste de l'API). On le ramène à nos slugs.
 */
function fromMobulaBlockchainId(id) {
  if (!id) return null
  const s = String(id)
  if (s === 'solana') return 'solana'
  return fromMobula(/^\d+$/.test(s) ? `evm:${s}` : s) ?? null
}
