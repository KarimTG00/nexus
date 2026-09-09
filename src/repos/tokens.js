/**
 * Accès aux collections `tokens` et `rejected_seen`.
 * Toute écriture passe par ici — le pipeline ne manipule jamais Mongo directement.
 */

import { col } from '../core/db/client.js'
import { SCHEMA_VERSION } from '../core/db/schema.js'
import { mod } from '../core/logger.js'

const log = mod('repo:tokens')
const MIN = 60_000

/** Normalise un symbole pour comparer des déploiements en rafale. */
export const normSymbol = s =>
  String(s ?? '').toUpperCase().replace(/^\$+/, '').replace(/[^A-Z0-9]/g, '') || null

/**
 * Densité de rafale : combien de tokens portent ce symbole normalisé sur les
 * dernières `hours` heures, toutes chaînes confondues.
 *
 * Volontairement PAS un filtre « clone vs original » : quand vingt tokens
 * identiques sortent en quelques heures, le premier n'est pas plus légitime
 * que les autres — ils appartiennent tous à la même opération. On mesure
 * l'appartenance à une rafale, on ne désigne pas de coupable.
 *
 * Une seule requête pour tous les symboles du lot.
 */
export async function symbolBurstCounts(symbols, hours = 24) {
  const norms = [...new Set(symbols.map(normSymbol).filter(Boolean))]
  if (!norms.length) return new Map()

  const since = new Date(Date.now() - hours * 3600_000)
  const rows = await col('tokens').aggregate([
    { $match: { symbol_norm: { $in: norms }, discovered_at: { $gte: since } } },
    { $group: {
        _id: '$symbol_norm',
        n: { $sum: 1 },
        chains: { $addToSet: '$chain' },
        deployers: { $addToSet: '$deployer' }
    } }
  ]).toArray()

  return new Map(rows.map(r => [r._id, {
    count: r.n,
    chains: r.chains.length,
    deployers: r.deployers.filter(Boolean).length
  }]))
}

// --- lectures --------------------------------------------------------------

/** Quels _id sont déjà en base ? (une requête, pas N) */
export async function findExistingIds(ids) {
  if (!ids.length) return new Map()
  const docs = await col('tokens')
    .find({ _id: { $in: ids } }, { projection: { _id: 1, status: 1, 'pools.address': 1 } })
    .toArray()
  return new Map(docs.map(d => [d._id, d]))
}

/** Rejets déjà enregistrés, pour ne pas re-traiter en boucle. */
export async function findRejected(ids) {
  if (!ids.length) return new Map()
  const docs = await col('rejected_seen').find({ _id: { $in: ids } }).toArray()
  return new Map(docs.map(d => [d._id, d]))
}

/** Tokens en attente du contrôle d'activité (phase B), échéance dépassée. */
export async function dueForActivityCheck(limit = 500) {
  return col('tokens').find({
    status: 'pending_activity',
    next_check_at: { $lte: new Date() }
  }).limit(limit).toArray()
}

/** Rejets éligibles à la seconde chance. */
export async function dueForSecondChance(limit = 500) {
  return col('rejected_seen').find({
    next_retry_at: { $lte: new Date(), $ne: null }
  }).limit(limit).toArray()
}

// --- écritures -------------------------------------------------------------

/**
 * Insère un token admis. Statut `pending_activity` : le contrôle d'activité
 * (phase B) se fera 15 min après la création du pool.
 */
export function buildAdmittedDoc(listing, { security, configVersion, filterResults }) {
  const created = listing.createdAt ?? new Date()
  const doc = {
    _id: listing._id,
    chain: listing.chain,
    address: listing.address,
    schema_version: SCHEMA_VERSION,
    config_version: configVersion,

    symbol: listing.symbol,
    symbol_norm: normSymbol(listing.symbol),
    name: listing.name,
    decimals: listing.decimals ?? security?.details?.decimals ?? null,
    supply: security?.details?.supply ?? null,

    deployer: listing.deployer,
    deployer_funder: null,          // renseigné par M4 (P11)
    launchpad: listing.launchpad,

    pools: [{
      address: listing.pool.address,
      dex: listing.pool.dex,
      quote: listing.pool.quote,
      created_at: listing.pool.createdAt,
      liquidity_usd: listing.pool.liquidityUsd,
      active: true
    }],
    primary_pool: listing.pool.address,

    // Lien entre homologues multichain — renseigné par l'étage 3 (multi-data).
    // Le market cap de Mobula est AGRÉGÉ sur toutes les chaînes : c'est voulu,
    // un token listé partout est influencé par les échanges de chacune.
    asset_id: null,
    contracts_count: null,
    is_multichain: null,
    deployments: null,

    status: 'pending_activity',
    tier: 'hot',
    next_check_at: new Date(created.getTime() + 15 * MIN),
    discovered_at: new Date(),
    admitted_at: null,
    archived_at: null,
    created_at: created,

    // Deux mesures distinctes, jamais confondues (voir docs/face1-pipeline.md) :
    //   consensus = ce que FOMO et les agregateurs affichent -> pour l'alerte
    //   aggregate = somme des pools, profondeur reelle       -> pour les filtres
    liquidity: {
      consensus: null,
      aggregate: null,
      divergence: null,
      primary_share: null,
      pool_count: null,
      source: null,
      measured_at: null
    },

    market: {
      mc: listing.market.mc,
      price: listing.market.price,
      liquidity_usd: listing.market.liquidityUsd,
      volume_24h: listing.market.volume24h,
      updated_at: new Date()
    },

    security: {
      checked: security?.checked ?? false,
      reason: security?.reason ?? null,
      ...(security?.details ?? {}),
      checked_at: new Date()
    },

    velocity: listing.velocity ?? {},
    holders: listing.holders ?? {},
    bonding: listing.bonding ?? {},
    socials: listing.socials ?? null,

    // Métriques candidates de la source — évaluées plus tard par M6
    candidates: listing.candidates ?? {},

    admission_filters: filterResults,
    triggers: [],
    frozen_early_buyers: null
  }

  return doc
}

/**
 * Insertion groupee. Mesure : une ecriture unitaire coute ~300 ms sur Atlas M0,
 * soit 158 s pour 533 tokens. Le meme lot en bulkWrite prend moins d une seconde
 * — 21x plus rapide. A cette echelle, ecrire un a un rendait le cycle plus long
 * que son propre intervalle.
 */
export async function bulkInsertTokens(docs) {
  if (!docs.length) return 0
  try {
    const r = await col('tokens').insertMany(docs, { ordered: false })
    return r.insertedCount
  } catch (e) {
    // Doublons tolérés : course entre deux cycles, sans gravité.
    if (e.code === 11000 || e.writeErrors) return e.result?.nInserted ?? e.insertedCount ?? 0
    throw e
  }
}

/**
 * Rafraîchit un token déjà connu à partir d'une donnée de découverte.
 * Gratuit : la donnée arrive de toute façon dans le cycle Pulse.
 */
/**
 * Remet en attente un token archive faute d activite, lorsque la source le
 * renvoie a nouveau.
 *
 * Reapparaitre dans Pulse signifie qu une donnee FRAICHE vient d arriver —
 * cas typique : la graduation, qui cree un nouveau pool des mois apres le
 * listing. Sans cette reprise, `dueForActivityCheck` ne lisant que les
 * `pending_activity`, ce token serait rafraichi indefiniment sans jamais
 * etre reevalue.
 *
 * Le filtre restreint la reprise aux seuls archivages pour inactivite : un
 * token ecarte pour une autre raison ne doit pas revenir par cette porte.
 */
export function buildResurrectOp(id) {
  return { updateOne: {
    filter: { _id: id, status: 'archived', rejection_reason: 'low_activity' },
    update: { $set: {
      status: 'pending_activity',
      tier: 'hot',
      next_check_at: new Date(),
      archived_at: null,
      rejection_reason: null
    }, $inc: { resurrections: 1 } }
  } }
}

export function buildRefreshOp(id, listing) {
  return { updateOne: { filter: { _id: id }, update: {
    $set: {
      'market.mc': listing.market.mc,
      'market.price': listing.market.price,
      'market.liquidity_usd': listing.market.liquidityUsd,
      'market.volume_24h': listing.market.volume24h,
      'market.updated_at': new Date(),
      velocity: listing.velocity,
      holders: listing.holders,
      bonding: listing.bonding,
      ...(listing.socials ? { socials: listing.socials } : {})
    }
  } } }
}

/**
 * Ajout d un pool, en operation groupee. Le filtre  * garantit l idempotence : on AJOUTE, on ne remplace jamais — la liste de
 * pools renvoyee par la source varie de 3 a 25 d un appel a l autre.
 */
export function buildAddPoolOp(id, pool) {
  return {
    updateOne: {
      filter: { _id: id, 'pools.address': { $ne: pool.address } },
      update: { $push: { pools: {
        address: pool.address, dex: pool.dex, quote: pool.quote,
        created_at: pool.createdAt, liquidity_usd: pool.liquidityUsd, active: true
      } } }
    }
  }
}

/**
 * Ajoute un pool à un token connu.
 * C'est ce qui rattrape les graduations de launchpad et les fragmentations —
 * l'événement arrive déjà, il suffit de ne pas le jeter.
 */
export async function addPoolIfNew(id, pool) {
  const r = await col('tokens').updateOne(
    { _id: id, 'pools.address': { $ne: pool.address } },
    {
      $push: {
        pools: {
          address: pool.address, dex: pool.dex, quote: pool.quote,
          created_at: pool.createdAt, liquidity_usd: pool.liquidityUsd, active: true
        }
      }
    }
  )
  if (r.modifiedCount) log.info({ token: id, pool: pool.address, dex: pool.dex }, 'nouveau pool')
  return r.modifiedCount > 0
}

/** Phase B réussie : le token entre en surveillance. */
export async function promoteToTracked(id, filterResults) {
  await col('tokens').updateOne({ _id: id }, {
    $set: {
      status: 'tracked',
      tier: 'hot',
      admitted_at: new Date(),
      next_check_at: new Date(Date.now() + 5 * MIN),
      activity_filters: filterResults
    }
  })
}

/**
 * Enregistre un rejet — filtre, VALEUR MESURÉE et seuil.
 * Stocker la valeur (et pas seulement un booléen) est ce qui rendra possible
 * le balayage de seuil de M5 sans recollecter de données.
 */
export function buildRejectionOp(listing, { reason, results, configVersion, retryable, retryDays = 7 }) {
  const now = new Date()
  const failed = results.find(r => r.name === reason)

  return {
    updateOne: {
      filter: { _id: listing._id },
      update: {
      $set: {
        chain: listing.chain,
        address: listing.address,
        symbol: listing.symbol,
        deployer: listing.deployer,
        reason,
        value: failed?.value ?? null,
        threshold: failed?.threshold ?? null,
        filters: results,
        config_version: configVersion,
        rejected_at: now,
        // TTL à 30 j : M7 doit pouvoir savoir si un top gainer de la semaine
        // avait été rejeté à l'admission.
        expires_at: new Date(now.getTime() + 30 * 86400_000),
        next_retry_at: retryable ? new Date(now.getTime() + 86400_000) : null,
        retry_until: retryable ? new Date(now.getTime() + retryDays * 86400_000) : null
      },
      $inc: { retry_count: 0 },
        $setOnInsert: { first_seen_at: now }
      },
      upsert: true
    }
  }
}

/** Applique un lot d operations sur une collection. */
export async function bulkOps(collection, ops) {
  if (!ops.length) return 0
  const r = await col(collection).bulkWrite(ops, { ordered: false })
  return (r.insertedCount ?? 0) + (r.modifiedCount ?? 0) + (r.upsertedCount ?? 0)
}

/**
 * Phase B non concluante : le token n'est PAS rejeté, il n'a simplement pas
 * encore démarré. On repousse l'échéance.
 *
 * `velocity['15min']` mesure les 15 DERNIÈRES minutes, pas les 15 premières :
 * un token calme à l'instant T peut s'enflammer au 3e jour. Le rejeter
 * définitivement reviendrait à rater précisément ce qu'on cherche.
 *
 * `quarantine` est réservé aux rejets APRÈS déclenchement (étage 5) —
 * confondre les deux populations fausserait l'analyse de M5.
 */
export async function deferActivity(id, results, { retryMinutes = 30 }) {
  await col('tokens').updateOne({ _id: id }, {
    $set: {
      next_check_at: new Date(Date.now() + retryMinutes * MIN),
      activity_filters: results
    },
    $inc: { activity_attempts: 1 }
  })
}

/** Fenêtre de seconde chance épuisée : le token n'a jamais démarré. */
export async function archiveToken(id, reason, results = null) {
  await col('tokens').updateOne({ _id: id }, {
    $set: {
      status: 'archived',
      tier: 'archived',
      rejection_reason: reason,
      archived_at: new Date(),
      next_check_at: null,
      ...(results ? { activity_filters: results } : {})
    }
  })
}

export async function bumpRetry(id, { exhausted }) {
  await col('rejected_seen').updateOne({ _id: id }, {
    $inc: { retry_count: 1 },
    $set: { next_retry_at: exhausted ? null : new Date(Date.now() + 86400_000) }
  })
}

export async function deleteRejection(id) {
  await col('rejected_seen').deleteOne({ _id: id })
}

/** Tokens en surveillance dont l'échéance est dépassée (chemin chaud). */
export async function dueForMonitoring(limit = 1000) {
  return col('tokens').find({
    status: { $in: ['tracked', 'triggered', 'alerted'] },
    next_check_at: { $lte: new Date() }
  }).sort({ next_check_at: 1 }).limit(limit).toArray()
}

/**
 * Applique un relevé de marché : marché, tier, échéance, et le lien
 * multichain quand la source le fournit.
 */
export function buildMarketUpdateOp(id, { market, tier, nextCheckAt, active, liquidity, primaryPool }) {
  const $set = { 'market.updated_at': new Date() }

  if (market) {
    if (market.mc !== null && market.mc !== undefined) $set['market.mc'] = market.mc
    if (market.price != null) $set['market.price'] = market.price
    if (market.liquidityUsd != null) $set['market.liquidity_usd'] = market.liquidityUsd
    if (market.volume24h != null) $set['market.volume_24h'] = market.volume24h
    if (market.supply != null) $set.supply = market.supply

    // Homologues multichain — le MC de Mobula est agrégé sur toutes les chaînes
    if (market.assetId != null) $set.asset_id = market.assetId
    if (market.contractsCount != null) {
      $set.contracts_count = market.contractsCount
      $set.is_multichain = market.isMultichain
      $set.deployments = market.deployments ?? null
    }
    // Mesure « consensus » : ce que FOMO et les agrégateurs affichent
    if (market.liquidityUsd != null) {
      $set['liquidity.consensus'] = market.liquidityUsd
      $set['liquidity.measured_at'] = new Date()
    }
  }

  if (liquidity) {
    $set['liquidity.aggregate'] = liquidity.aggregate ?? null
    $set['liquidity.divergence'] = liquidity.divergence ?? null
    $set['liquidity.primary_share'] = liquidity.primaryShare ?? null
    $set['liquidity.pool_count'] = liquidity.poolCount ?? null
    $set['liquidity.source'] = liquidity.source ?? null
    $set['liquidity.measured_at'] = new Date()
  }

  if (tier) { $set.tier = tier.tier; $set.tier_reason = tier.reason }
  if (nextCheckAt !== undefined) $set.next_check_at = nextCheckAt
  if (primaryPool) $set.primary_pool = primaryPool
  if (active) $set.last_activity_at = new Date()

  const update = { $set }
  if (tier?.tier === 'archived') {
    update.$set.status = 'archived'
    update.$set.archived_at = new Date()
    update.$set.rejection_reason = 'inactive'
  }

  return { updateOne: { filter: { _id: id }, update } }
}

/** Variante unitaire, pour les appels isolés. */
export async function applyMarketUpdate(id, opts) {
  const op = buildMarketUpdateOp(id, opts)
  await col('tokens').updateOne(op.updateOne.filter, op.updateOne.update)
}

/** Fusionne les pools découverts par la source dans `pools[]`, sans jamais remplacer. */
export async function mergePools(id, pools) {
  if (!pools?.length) return 0
  const doc = await col('tokens').findOne({ _id: id }, { projection: { pools: 1 } })
  const known = new Set((doc?.pools ?? []).map(p => String(p.address).toLowerCase()))
  const toAdd = pools
    .filter(p => p.address && !known.has(String(p.address).toLowerCase()))
    .map(p => ({
      address: p.address, dex: p.dex, quote: p.quote,
      created_at: p.createdAt ?? null, liquidity_usd: p.liquidityUsd ?? null, active: true
    }))
  if (!toAdd.length) return 0
  await col('tokens').updateOne({ _id: id }, { $push: { pools: { $each: toAdd } } })
  return toAdd.length
}

export async function deleteRejections(ids) {
  if (!ids.length) return 0
  const r = await col('rejected_seen').deleteMany({ _id: { $in: ids } })
  return r.deletedCount
}
