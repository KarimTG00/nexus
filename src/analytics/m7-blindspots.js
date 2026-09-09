/**
 * M7 — Angles morts.
 *
 * Tous les autres modules ne regardent que ce qui est DANS la base. M7 est le
 * seul à voir ce que le pipeline n'a JAMAIS vu — sa plus grosse source
 * d'échec, invisible autrement.
 *
 * Méthode : récupérer les meilleures performances du marché depuis une source
 * externe, puis demander à la base, pour chacune : l'a-t-on vue, et à quel
 * étage est-elle morte ?
 *
 * Chaque ligne du rapport appelle un correctif DIFFÉRENT :
 *   rejeté à l'admission  → desserrer un seuil (une ligne de configuration)
 *   jamais découvert      → chaîne, DEX ou source manquante (intégration)
 *   jamais déclenché      → MC mal calculé ou tier mal promu (débogage)
 *   rejeté au déclenchement → domaine de M5, pas de M7
 *
 * Sans cette ventilation, on constaterait « on rate des tokens » sans savoir
 * où chercher.
 */

import { getSource } from '../adapters/sources/index.js'
import { col } from '../core/db/client.js'
import { enabledChains } from '../core/config/store.js'
import { fromMobula, tokenId } from '../core/chains.js'
import { request } from '../core/net/http.js'
import { mod } from '../core/logger.js'

const log = mod('m7')

/**
 * Meilleures performances du marché, hors de notre base.
 * Pulse trié par variation 24 h — 1 crédit pour 10 vues.
 */
export async function topGainers(cfg, { limit = 50, minMc = 150_000, maxAgeDays = 7 } = {}) {
  const chains = enabledChains(cfg)

  // ⚠️ FILTRE D'ÂGE INDISPENSABLE. Sans lui, le classement par variation 24 h
  // remonte de vieux tokens qui pompent — mesuré sur BNB : des lancements de
  // 111 à 276 jours dominaient le palmarès. Or on est un scanner de NOUVEAUX
  // tokens : les compter dans le dénominateur mesure notre taux de capture
  // contre une population qu'on ne cherche pas, et fabrique un faux trou de
  // couverture (2 % de capture annoncés, sur le mauvais échantillon).
  const since = new Date(Date.now() - maxAgeDays * 86400_000).toISOString()

  const views = chains.map(chainId => ({
    name: chainId,
    model: 'bonded',
    chainId: [chainId],
    limit,
    sortBy: 'price_change_24h',
    sortOrder: 'desc',
    filters: {
      market_cap: { gte: minMc },
      liquidity: { gte: 20_000 },
      created_at: { gte: since }
    }
  }))

  const { json } = await request('https://api.mobula.io/api/2/pulse', {
    method: 'POST',
    headers: { Authorization: process.env.MOBULA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ views: views.slice(0, 10) }),
    timeoutMs: 90_000,
    retries: 1
  })

  const out = []
  for (const [mobulaChain, payload] of Object.entries(json ?? {})) {
    const chain = fromMobula(mobulaChain)
    if (!chain) continue
    for (const item of payload?.data ?? []) {
      const pair = item.pair
      const base = pair?.[pair?.baseToken]
      if (!base?.address) continue
      out.push({
        _id: tokenId(chain, chain === 'solana' ? base.address : base.address.toLowerCase()),
        chain,
        symbol: base.symbol ?? null,
        mc: item.market_cap ?? null,
        priceChange24h: item.price_change_24h ?? null,
        liquidity: pair.liquidity ?? null,
        createdAt: pair.createdAt ? new Date(pair.createdAt) : null
      })
    }
  }
  return out
}

/** À quel étage ce token nous a-t-il échappé ? */
async function classify(gainer) {
  const token = await col('tokens').findOne({ _id: gainer._id })

  if (!token) {
    const rejet = await col('rejected_seen').findOne({ _id: gainer._id })
    return rejet
      ? { sort: 'rejete_admission', detail: rejet.reason, valeur: rejet.value, seuil: rejet.threshold }
      : { sort: 'jamais_decouvert', detail: null }
  }

  const trigger = await col('trigger_snapshots')
    .find({ token: gainer._id }).sort({ ts: -1 }).limit(1).next()

  if (!trigger) {
    return { sort: 'jamais_declenche', detail: token.status, mcConnu: token.market?.mc ?? null }
  }

  if (trigger.decision === 'alerted') {
    const alerte = await col('alerts').findOne({ trigger_id: trigger._id })
    return {
      sort: 'alerte',
      detail: trigger.threshold,
      mcAlerte: trigger.context?.mc ?? null,
      envoyee: Boolean(alerte),
      score: trigger.score
    }
  }

  return {
    sort: 'rejete_declenchement',
    detail: trigger.rejection_reason,
    mcDeclenchement: trigger.context?.mc ?? null,
    score: trigger.score
  }
}

const ORDRE = ['alerte', 'rejete_declenchement', 'jamais_declenche', 'rejete_admission', 'jamais_decouvert']

export async function run(cfg, { limit = 50, maxAgeDays = 7 } = {}) {
  const gainers = await topGainers(cfg, { limit, maxAgeDays })
  if (!gainers.length) {
    log.warn('aucune performance récupérée — analyse impossible')
    return null
  }

  const resultats = []
  for (const g of gainers) resultats.push({ ...g, ...(await classify(g)) })

  const ventilation = {}
  for (const s of ORDRE) ventilation[s] = resultats.filter(r => r.sort === s).length

  // Motifs de rejet, pour savoir QUEL seuil desserrer
  const motifs = {}
  for (const r of resultats) {
    if (r.sort === 'rejete_admission' || r.sort === 'rejete_declenchement') {
      const cle = `${r.sort}:${r.detail}`
      motifs[cle] = (motifs[cle] ?? 0) + 1
    }
  }

  // Latence : à quel MC alerte-t-on par rapport au sommet atteint ?
  const alertes = resultats.filter(r => r.sort === 'alerte' && r.mcAlerte && r.mc)
  const latence = alertes.length
    ? {
        n: alertes.length,
        multiple_median: median(alertes.map(a => a.mc / a.mcAlerte)),
        mc_alerte_median: median(alertes.map(a => a.mcAlerte))
      }
    : null

  const rapport = {
    period: semaine(),
    computed_at: new Date(),
    echantillon: resultats.length,
    age_max_jours: maxAgeDays,
    age_median_h: median(resultats.filter(r=>r.createdAt).map(r=>(Date.now()-r.createdAt)/3600000)),
    ventilation,
    taux_capture: +((ventilation.alerte + ventilation.rejete_declenchement) / resultats.length).toFixed(3),
    motifs,
    latence,
    // On garde les cas concrets : « jamais découvert » est celui qui demande
    // une intégration, donc celui qu'on veut pouvoir inspecter.
    jamais_decouverts: resultats.filter(r => r.sort === 'jamais_decouvert')
      .slice(0, 20).map(r => ({ id: r._id, symbol: r.symbol, chain: r.chain, mc: r.mc })),
    par_chaine: chainBreakdown(resultats)
  }

  await col('analytics_blindspots').updateOne(
    { period: rapport.period }, { $set: rapport }, { upsert: true })

  log.info({ ...ventilation, taux_capture: rapport.taux_capture }, 'angles morts')
  return rapport
}

function chainBreakdown(resultats) {
  const out = {}
  for (const r of resultats) {
    out[r.chain] ??= { total: 0, vus: 0, jamais_decouverts: 0 }
    out[r.chain].total++
    if (r.sort === 'jamais_decouvert') out[r.chain].jamais_decouverts++
    else out[r.chain].vus++
  }
  return out
}

const median = arr => {
  const s = arr.slice().sort((a, b) => a - b)
  return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : null
}

function semaine(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const debut = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - debut) / 86400000 + 1) / 7)).padStart(2, '0')}`
}
