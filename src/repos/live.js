/**
 * Écritures du flux temps réel pump.fun.
 *
 * Trois collections :
 *   tokens      les tokens suivis en direct, avec leur sous-document `live`
 *   trades      les trades individuels retenus pour l'étude
 *   pump_pools  la correspondance pool PumpSwap → mint
 *
 * Les valeurs temps réel vivent dans `live.*` et JAMAIS dans `market.*` : la
 * découverte Mobula réécrit `market` à chaque passage, et deux sources qui
 * écrivent le même champ se contredisent sans que personne ne le voie.
 */

import { col } from '../core/db/client.js'
import { SCHEMA_VERSION, collections } from '../core/db/schema.js'
import { normSymbol } from './tokens.js'
import { partMicro } from '../collector/pump/state.js'
import { mod } from '../core/logger.js'

const log = mod('repo:live')

export const idToken = mint => `solana:${mint}`

/**
 * Index des collections du flux, créés au démarrage. Les définitions restent
 * dans schema.js : ce n'est qu'une application, pour qu'un déploiement n'ait
 * pas à attendre un `db:init` manuel — sans son index TTL, `trades` ne
 * s'effacerait jamais.
 */
export async function assurerIndex() {
  for (const c of collections.filter(x => ['trades', 'pump_pools', 'stream_gaps'].includes(x.name))) {
    for (const { key, ...options } of c.indexes ?? []) {
      try {
        await col(c.name).createIndex(key, options)
      } catch (e) {
        // MongoDB refuse de recréer un index existant avec d'autres options
        // (code 85). C'est le cas du TTL de `trades`, créé à 14 jours puis
        // ramené à 3 : sans ce rattrapage, la rétention réelle serait restée
        // à 14 jours pendant que la configuration affirmait 3, et rien
        // d'autre qu'un avertissement au démarrage ne l'aurait signalé.
        if ((e.code === 85 || e.code === 86) && options.name) {
          try {
            await col(c.name).dropIndex(options.name)
            await col(c.name).createIndex(key, options)
            log.info({ collection: c.name, index: options.name, options },
              'index recréé avec ses nouvelles options')
          } catch (e2) {
            log.warn({ collection: c.name, index: options.name, err: e2.message }, 'index non recréé')
          }
          continue
        }
        log.warn({ collection: c.name, index: options.name, err: e.message }, 'index non créé')
      }
    }
  }
}

/** Sous-document `live` : l'état du token tel que le flux le mesure. */
export function docLive(e) {
  const part = partMicro(e)
  let acheteurs = 0
  for (const w of e.wallets.values()) if (w.achats > 0) acheteurs++

  return {
    source: 'stream',
    complet: e.complet,
    mc: e.mc,
    mc_max: e.mcMax || null,
    price_usd: e.prix,
    trades: e.n,
    buys: e.achats,
    sells: e.ventes,
    // Liquidité réelle du pool, lue sur les réserves — jamais un agrégat.
    liquidity_usd: e.liquiditeUsd === null ? null : Math.round(e.liquiditeUsd),
    // Acheteurs au-dessus du seuil de micro-trade : les vrais, par opposition
    // à ceux que le déployeur fabrique.
    real_buyers: e.acheteursReels,
    // Part de l'offre encore détenue par les auteurs : la mesure du risque de
    // sortie, et la seule qu'aucun fournisseur ne vend, puisqu'elle suppose
    // d'avoir suivi le token depuis sa première seconde.
    authors_share: e.partAuteurs,
    micro_share: part === null ? null : +part.toFixed(4),
    micro_sample: e.usdConnus,
    volume_usd: Math.round(e.volumeUsd),
    buyers: acheteurs,
    graduated: e.gradue,
    graduated_at: e.gradueA ? new Date(e.gradueA) : null,
    pool: e.pool,
    first_buyers: e.premiers.map(p => ({ wallet: p.wallet, rank: p.rang, ts: new Date(p.ts) })),
    authors: e.auteursFiges,
    authors_sold_before_entry: e.ventesAuteursAvant,
    author_sells: [...e.ventesAuteurs].map(([wallet, v]) => ({ wallet, ts: new Date(v.ts), tokens: v.tokens })),
    alerts: {
      entry: e.alertes.entree ? { ...e.alertes.entree, at: new Date(e.alertes.entree.at) } : null,
      // Multiples de sortie déjà signalés : { multiple, at, mc }
      multiples: (e.alertes.multiples ?? []).map(m => ({ ...m, at: new Date(m.at) })),
      authors: e.alertes.auteurs ? { ...e.alertes.auteurs, at: new Date(e.alertes.auteurs.at) } : null
    },
    study: Boolean(e.etude),
    control: Boolean(e.temoin),
    updated_at: new Date()
  }
}

/** Document complet d'un token entré par le flux. Sans `live`, écrit à part. */
function docToken(e, { configVersion, now }) {
  const pool = e.pool
    ? { address: e.pool, dex: 'pumpswap', quote: 'SOL', active: true }
    : e.curve ? { address: e.curve, dex: 'pumpfun', quote: 'SOL', active: true } : null

  return {
    _id: idToken(e.mint),
    chain: 'solana',
    address: e.mint,
    schema_version: SCHEMA_VERSION,
    config_version: configVersion,

    symbol: e.symbol,
    symbol_norm: normSymbol(e.symbol),
    name: e.name,
    decimals: 6,
    supply: e.supply ?? null,

    deployer: e.creator,
    deployer_funder: null,
    launchpad: 'pumpfun',
    pools: pool ? [pool] : [],
    primary_pool: pool?.address ?? null,

    // Visible d'emblée : plus de salle d'attente `pending_activity`. Le flux
    // mesure l'activité en continu, un contrôle à +15 min n'a plus d'objet.
    status: 'tracked',
    tier: 'hot',
    // `null` sort le token des relevés Mobula de l'étage de surveillance :
    // il a ses données en direct, et 5 800 créations par jour relevées
    // toutes les 5 minutes épuiseraient le budget de crédits en une heure.
    next_check_at: null,
    discovered_at: new Date(e.vuA),
    admitted_at: now,
    archived_at: null,
    created_at: e.createdAt ? new Date(e.createdAt) : null,

    market: { mc: e.mc, price: e.prix, liquidity_usd: null, volume_24h: null, updated_at: now },
    // Pas contrôlée ici. Pump.fun révoque les autorités de mint et de gel par
    // construction, mais « par construction » n'est pas une vérification.
    security: { checked: false, reason: 'non contrôlée (flux temps réel)', checked_at: now },

    velocity: {},
    holders: {},
    bonding: {},
    socials: null,
    candidates: {},
    admission_filters: [],
    triggers: [],
    frozen_early_buyers: null
  }
}

/**
 * Écrit le token s'il n'existe pas ; sinon le rend visible s'il attendait.
 * @returns {boolean} vrai si le token vient d'être créé
 */
export async function persisterToken(e, { configVersion }) {
  const id = idToken(e.mint)
  const now = new Date()
  const r = await col('tokens').updateOne(
    { _id: id },
    { $setOnInsert: docToken(e, { configVersion, now }), $set: { live: docLive(e) } },
    { upsert: true }
  )

  // Token déjà connu du pipeline Mobula — découvert pendant une coupure du
  // flux. On le sort de la salle d'attente et des relevés périodiques : le
  // flux en a désormais la charge, et le déclencheur Mobula l'ignore.
  if (!r.upsertedCount) {
    await col('tokens').updateOne(
      { _id: id, status: { $in: ['pending_activity', 'archived'] } },
      { $set: { status: 'tracked', tier: 'hot', admitted_at: now, next_check_at: null,
                archived_at: null, rejection_reason: null } }
    )
  }
  return r.upsertedCount > 0
}

/** Met à jour `live` pour un lot de tokens déjà écrits. */
export async function majLive(etats) {
  if (!etats.length) return 0
  const r = await col('tokens').bulkWrite(
    etats.map(e => ({ updateOne: { filter: { _id: idToken(e.mint) }, update: { $set: { live: docLive(e) } } } })),
    { ordered: false }
  )
  return r.modifiedCount
}

/** Trades de l'étude. Un doublon (reconnexion, redémarrage) n'est pas une erreur. */
export async function ajouterTrades(docs) {
  if (!docs.length) return 0
  try {
    const r = await col('trades').insertMany(docs, { ordered: false })
    return r.insertedCount
  } catch (e) {
    if (e.code === 11000 || e.writeErrors?.every?.(w => w.code === 11000)) return e.insertedCount ?? 0
    throw e
  }
}

export async function enregistrerPool({ pool, mint, quoteMint, baseDec = null, quoteDec = null }) {
  await col('pump_pools').updateOne(
    { _id: pool },
    { $setOnInsert: { mint, quote_mint: quoteMint, base_dec: baseDec, quote_dec: quoteDec, created_at: new Date() } },
    { upsert: true }
  )
}

export async function chargerPools() {
  const docs = await col('pump_pools').find({}, { projection: { mint: 1, quote_mint: 1, base_dec: 1, quote_dec: 1 } }).toArray()
  return new Map(docs.map(d => [d._id, {
    mint: d.mint, quoteMint: d.quote_mint, baseDec: d.base_dec ?? null, quoteDec: d.quote_dec ?? null
  }]))
}

/** Tokens du flux mis à jour depuis `depuis` : de quoi reprendre après un redémarrage. */
export async function chargerSuivis(depuis) {
  return col('tokens').find(
    { 'live.source': 'stream', 'live.updated_at': { $gte: depuis } },
    { projection: { address: 1, symbol: 1, name: 1, deployer: 1, created_at: 1, discovered_at: 1,
                    supply: 1, triggers: 1, live: 1 } }
  ).toArray()
}

/**
 * Enregistre une coupure du flux.
 *
 * `debut` est l'instant du dernier message reçu, `fin` celui de la reprise :
 * entre les deux, on ne sait pas ce qui s'est passé sur la chaîne. L'étude
 * doit écarter ces fenêtres plutôt que d'y lire une absence d'activité.
 */
export async function enregistrerCoupure({ source, debut, fin, raison, couvert = false }) {
  await col('stream_gaps').insertOne({
    source, debut, fin,
    duree_s: Math.round((+fin - +debut) / 1000),
    raison,
    // `couvert` : une autre connexion recevait pendant ce trou. La coupure est
    // alors sans conséquence sur les données, et l'étude doit l'ignorer —
    // sinon on déclarerait aveugle une période où l'on voyait très bien.
    couvert,
    created_at: new Date()
  })
}

/** Coupures depuis une date, dans l'ordre. */
export async function coupures(depuis) {
  return col('stream_gaps').find({ debut: { $gte: depuis } }).sort({ debut: 1 }).toArray()
}

/** Tokens du flux retombés dans l'inactivité sans jamais avoir été évalués. */
export async function archiver(ids) {
  if (!ids.length) return 0
  const r = await col('tokens').updateMany(
    { _id: { $in: ids }, status: 'tracked' },
    { $set: { status: 'archived', tier: 'archived', archived_at: new Date(), rejection_reason: 'stream_inactif' } }
  )
  return r.modifiedCount
}
