/**
 * ÉTAGE 0 — Découverte
 *
 * Trie le flux Pulse en quatre destins :
 *   déjà connu   → rafraîchi gratuitement, et son pool ajouté s'il est nouveau
 *   déjà rejeté  → ignoré, sauf seconde chance échue
 *   nouveau      → transmis à l'admission
 *   inexploitable→ compté
 *
 * Le rafraîchissement des tokens connus ne coûte rien : la donnée arrive de
 * toute façon dans le cycle Pulse. Ne pas la jeter, c'est ce qui rattrape les
 * graduations de launchpad et les fragmentations de liquidité.
 */

import { getSource } from '../../adapters/sources/index.js'
import { enabledChains } from '../../core/config/store.js'
import { fromMobula } from '../../core/chains.js'
import * as tokensRepo from '../../repos/tokens.js'
import { mod } from '../../core/logger.js'

const log = mod('stage:discovery')

export async function discover(cfg) {
  const src = getSource(cfg)
  const chains = enabledChains(cfg).map(fromMobula).filter(Boolean)

  // Voie POST : 10 vues pour 1 crédit, avec filtrage côté serveur.
  // Repli sur le GET paginé si elle ne renvoie rien.
  let listings = []
  if (cfg.sources.discovery_use_post !== false && typeof src.getNewListingsPost === 'function') {
    listings = await src.getNewListingsPost(chains, {
      serverLiquidityFloor: cfg.sources.discovery_server_liquidity_floor ?? 500,
      pages: cfg.sources.discovery_post_pages ?? 1
    })
  }
  if (!listings.length) {
    log.warn('POST sans résultat — repli sur la découverte paginée en GET')
    listings = await src.getNewListings(chains, {
      maxPages: cfg.sources.discovery_max_pages ?? 4,
      freshMinutes: cfg.sources.discovery_fresh_minutes ?? 10
    })
  }
  const stats = {
    vus: listings.length,
    connus: 0, poolsAjoutes: 0, rejetesConnus: 0, reprises: 0,
    secondeChance: 0, nouveaux: 0
  }

  if (!listings.length) return { candidates: [], stats }

  const ids = listings.map(l => l._id)
  const [existing, rejected] = await Promise.all([
    tokensRepo.findExistingIds(ids),
    tokensRepo.findRejected(ids)
  ])

  const candidates = []
  // Ecritures accumulees : ~300 ms l unite sur Atlas M0, soit des minutes
  // pour quelques centaines de tokens connus. Groupees, moins d une seconde.
  const ops = []
  // Lot separe : `poolsAjoutes` se deduit de `ecrites - connus`, qui suppose
  // une modification par token connu. Melanger les reprises fausserait ce compte.
  const opsReprise = []
  const now = new Date()

  for (const listing of listings) {
    const known = existing.get(listing._id)

    if (known) {
      stats.connus++
      ops.push(tokensRepo.buildRefreshOp(listing._id, listing))
      // La source le renvoie : donnee fraiche disponible. Si on l avait archive
      // faute d activite, c est le moment de lui redonner sa chance — le filtre
      // de l operation la rend sans effet sur tous les autres.
      opsReprise.push(tokensRepo.buildResurrectOp(listing._id))
      if (listing.pool?.address) ops.push(tokensRepo.buildAddPoolOp(listing._id, listing.pool))
      continue
    }

    const rej = rejected.get(listing._id)
    if (rej) {
      const eligible = rej.next_retry_at && rej.next_retry_at <= now
        && (!rej.retry_until || rej.retry_until > now)
      if (!eligible) { stats.rejetesConnus++; continue }
      stats.secondeChance++
      candidates.push({ listing, retry: rej })
      continue
    }

    stats.nouveaux++
    candidates.push({ listing, retry: null })
  }

  const ecrites = await tokensRepo.bulkOps('tokens', ops)
  stats.reprises = await tokensRepo.bulkOps('tokens', opsReprise)
  stats.poolsAjoutes = Math.max(0, ecrites - stats.connus)

  log.info(stats, 'découverte')
  return { candidates, stats }
}
