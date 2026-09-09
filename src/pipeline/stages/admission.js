/**
 * ÉTAGE 1 — Admission
 *
 * Phase A (immédiate) : liquidité, réputation du déployeur, wallets toxiques,
 *                       sécurité du contrat.
 * Phase B (t+15 min)  : activité réelle, lue sur la vélocité déjà collectée.
 *
 * Les données à pré-charger sont déduites du champ `requires` des filtres ACTIFS.
 * Désactiver un filtre supprime automatiquement son coût de collecte.
 */

import { runFilters, requirementsFor } from '../filters/index.js'
import { socialPresence } from '../tiers.js'
import { getAdapter } from '../../adapters/chains/index.js'
import * as tokensRepo from '../../repos/tokens.js'
import * as rep from '../../repos/reputation.js'
import { mod } from '../../core/logger.js'

const log = mod('stage:admission')

/** Filtres dont l'échec est corrigible dans le temps → seconde chance. */
const RETRYABLE = new Set(['low_liquidity', 'low_activity'])

// ---------------------------------------------------------------------------
// Phase A
// ---------------------------------------------------------------------------

export async function admit(candidates, cfg) {
  const stats = { evalues: candidates.length, admis: 0, rejetes: {}, ignoresRetry: 0 }
  if (!candidates.length) return stats

  const listings = candidates.map(c => c.listing)
  const need = await requirementsFor('admission')

  // --- pré-chargement, en lots -------------------------------------------
  const ctxData = {}

  if (need.includes('security')) {
    ctxData.security = new Map()
    const byChain = new Map()
    for (const l of listings) {
      if (!byChain.has(l.chain)) byChain.set(l.chain, [])
      byChain.get(l.chain).push(l.address)
    }
    for (const [chain, addrs] of byChain) {
      const adapter = getAdapter(chain)
      const res = await adapter.checkBaseSecurityBatch(addrs)
      for (const [addr, r] of res) ctxData.security.set(`${chain}:${addr}`, r)
    }
  }

  if (need.includes('deployer_reputation')) {
    ctxData.deployers = await rep.deployerReputations(listings.map(l => l.deployer))
  }

  if (need.includes('toxic_buyers')) {
    ctxData.toxic = await rep.toxicBuyerCounts(listings.map(l => l._id))
  }

  // Densité de rafale — mesurée sur NOTRE base, coût nul.
  // Enregistrée en métrique candidate, jamais bloquante : c'est M6 qui dira
  // si appartenir à une rafale prédit quoi que ce soit.
  const bursts = await tokensRepo.symbolBurstCounts(listings.map(l => l.symbol))
  const batchBurst = new Map()
  for (const l of listings) {
    const k = tokensRepo.normSymbol(l.symbol)
    if (k) batchBurst.set(k, (batchBurst.get(k) ?? 0) + 1)
  }

  // --- évaluation (accumulation, écriture groupée en fin de boucle) -------
  const aInserer = []
  const rejets = []
  const aSupprimer = []

  for (const { listing, retry } of candidates) {
    const key = tokensRepo.normSymbol(listing.symbol)
    const seen = bursts.get(key)
    listing.candidates = {
      ...listing.candidates,
      symbol_burst_24h: (seen?.count ?? 0) + (batchBurst.get(key) ?? 0),
      symbol_burst_chains: seen?.chains ?? 1,
      symbol_burst_deployers: seen?.deployers ?? 1,
      // Presence sociale : meilleur predicteur connu a ce stade, enregistre
      // pour que M6 le juge sur NOS donnees et pas sur celles de l etude.
      social_score: socialPresence(listing.socials).score,
      social_channels: socialPresence(listing.socials).count,
      social_telegram: socialPresence(listing.socials).telegram
    }

    const ctx = {
      _id: listing._id,
      chain: listing.chain,
      address: listing.address,
      listing,
      security: ctxData.security?.get(listing._id) ?? null,
      deployerRep: ctxData.deployers?.get(listing.deployer) ?? null,
      toxicBuyers: ctxData.toxic?.get(listing._id) ?? null
    }

    const { passed, results, rejectionReason } = await runFilters('admission', ctx, cfg)

    if (passed) {
      aInserer.push(tokensRepo.buildAdmittedDoc(listing, {
        security: ctx.security,
        configVersion: cfg._id,
        filterResults: results
      }))
      if (retry) aSupprimer.push(listing._id)
      continue
    }

    stats.rejetes[rejectionReason] = (stats.rejetes[rejectionReason] ?? 0) + 1

    if (retry) {
      const days = cfg.thresholds.admission.second_chance_days
      const exhausted = (retry.retry_count ?? 0) + 1 >= days
      rejets.push({ updateOne: { filter: { _id: listing._id },
        update: { $inc: { retry_count: 1 },
                  $set: { next_retry_at: exhausted ? null : new Date(Date.now() + 86400_000) } } } })
      stats.ignoresRetry++
    } else {
      rejets.push(tokensRepo.buildRejectionOp(listing, {
        reason: rejectionReason,
        results,
        configVersion: cfg._id,
        retryable: RETRYABLE.has(rejectionReason) && cfg.features.second_chance.enabled,
        retryDays: cfg.thresholds.admission.second_chance_days
      }))
    }
  }

  // Ecriture groupee : ~300 ms par ecriture unitaire sur Atlas M0, contre
  // moins d une seconde pour tout le lot. Sans ca le cycle depassait son
  // propre intervalle de 5 minutes.
  stats.admis = await tokensRepo.bulkInsertTokens(aInserer)
  await tokensRepo.bulkOps('rejected_seen', rejets)
  if (aSupprimer.length) await tokensRepo.deleteRejections(aSupprimer)

  log.info(stats, 'admission phase A')
  return stats
}

// ---------------------------------------------------------------------------
// Phase B — contrôle d'activité à t+15 min
// ---------------------------------------------------------------------------

export async function checkActivity(cfg) {
  const due = await tokensRepo.dueForActivityCheck()
  const stats = { evalues: due.length, promus: 0, reportes: 0, archives: 0, sansDonnees: 0 }
  if (!due.length) return stats

  // Fenêtre de patience, bornée par la FENÊTRE PULSE — pas par un délai choisi.
  //
  // `velocity` n'est rafraîchi que par `buildRefreshOp`, donc uniquement tant
  // que la source continue de renvoyer le token : environ 3 h. Passé ce délai
  // le document est gelé, et rejouer le filtre toutes les 30 min pendant 7
  // jours ne pouvait plus rien changer — mesuré : 10 824 tokens réévalués en
  // boucle sur des chiffres figés, 4,3 fois en moyenne, jusqu'à 11.
  //
  // Le repli `?? 3` est nécessaire : `active()` ne fusionne pas avec les
  // valeurs par défaut, les versions de configuration antérieures n'ont pas la clé.
  const windowMs = (cfg.thresholds.admission.activity_window_hours ?? 3) * 3600_000
  const retryMinutes = cfg.thresholds.admission.activity_retry_minutes ?? 30
  const ops = []

  for (const token of due) {
    const ctx = { _id: token._id, chain: token.chain, address: token.address, velocity: token.velocity }
    const { passed, results } = await runFilters('activity', ctx, cfg)

    if (results.some(r => r.skipped)) stats.sansDonnees++

    const now = new Date()
    if (passed) {
      ops.push({ updateOne: { filter: { _id: token._id }, update: { $set: {
        status: 'tracked', tier: 'hot', admitted_at: now,
        next_check_at: new Date(Date.now() + 5 * 60_000), activity_filters: results } } } })
      stats.promus++
      continue
    }

    const born = token.created_at ?? token.discovered_at ?? now
    if (Date.now() - born.getTime() > windowMs) {
      ops.push({ updateOne: { filter: { _id: token._id }, update: { $set: {
        status: 'archived', tier: 'archived', rejection_reason: 'low_activity',
        archived_at: now, next_check_at: null, activity_filters: results } } } })
      stats.archives++
    } else {
      ops.push({ updateOne: { filter: { _id: token._id }, update: {
        $set: { next_check_at: new Date(Date.now() + retryMinutes * 60_000), activity_filters: results },
        $inc: { activity_attempts: 1 } } } })
      stats.reportes++
    }
  }

  await tokensRepo.bulkOps('tokens', ops)
  log.info(stats, 'admission phase B')
  return stats
}
