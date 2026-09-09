/**
 * Tiers de surveillance — « à quelle fréquence je regarde ce token ? »
 *
 * À ne pas confondre avec les SEUILS de déclenchement, qui sont des niveaux de
 * market cap (150K, 500K…). Le tier est une cadence, le seuil est un palier.
 *
 * Sans tiers : 4 000 tokens × 288 cycles = 1 152 000 vérifications/jour.
 * Avec tiers + lot de 50 : ~3 100 crédits/jour.
 *
 * Principe : le flux de découverte PROMEUT (un token qui trade repasse hot
 * en quelques secondes), le janitor RÉTROGRADE.
 */

export const TIERS = ['hot', 'warm', 'cold', 'archived']

/**
 * Présence sociale — le meilleur prédicteur connu à ce stade du cycle de vie.
 *
 * Source : analyse de survie sur 832 941 lancements pump.fun
 * (arxiv 2607.02823, concordance 0,858) :
 *   Telegram   HR 5,40   → 1,485 % de graduations contre 0,166 %  (×8,9)
 *   MC initial HR 4,51
 *   Twitter    HR 1,31
 *   Site web   HR 1,19
 *   les trois            → 1,919 % contre 0,110 %                 (×17,4)
 *
 * Réserves assumées : l'étude porte sur pump.fun/Solana et mesure la
 * GRADUATION (~69 K de MC), pas notre définition du succès. Sa fenêtre
 * d'observation est de ~6 min, donc les taux sont des bornes basses.
 * On s'en sert pour moduler l'attention, jamais pour rejeter — et le score
 * est enregistré en métrique candidate pour que M6 puisse le juger sur NOS
 * données plutôt que sur les siennes.
 */
export function socialPresence(socials) {
  const has = v => Boolean(v && String(v).trim())
  const telegram = has(socials?.telegram)
  const twitter = has(socials?.twitter)
  const website = has(socials?.website)
  const count = [telegram, twitter, website].filter(Boolean).length

  // Pondération à l'image des hazard ratios, ramenée sur 100.
  const score = Math.min(100, Math.round(
    (telegram ? 60 : 0) + (twitter ? 25 : 0) + (website ? 15 : 0)))

  return { telegram, twitter, website, count, score, any: count > 0 }
}

const RANK = { hot: 0, warm: 1, cold: 2, archived: 3 }
/** Cadence immediatement plus lente — la modulation ralentit d'un cran. */
const SLOWER = { hot: 'warm', warm: 'cold', cold: 'cold', archived: 'archived' }
const capTier = (tier, max) => (RANK[tier] < RANK[max] ? max : tier)

/**
 * Décide du tier d'un token à partir de son état courant.
 * @returns {{ tier, reason, nextCheckMinutes }}
 */
export function decideTier(token, cfg, { now = Date.now() } = {}) {
  const t = cfg.tiers
  const mc = token.market?.mc ?? 0
  const lastActivity = token.last_activity_at?.getTime?.() ?? token.created_at?.getTime?.() ?? now
  const inactiveHours = (now - lastActivity) / 3_600_000
  const social = socialPresence(token.socials)

  const out = (tier, reason) => {
    // Modulation sociale — RALENTIT d'un cran, ne rejette jamais. Un token
    // sans réseaux reste suivi ; s'il décolle, la cadence dégradée le rattrape,
    // et M5 garde de quoi juger la règle.
    //
    // ⚠️ DÉSACTIVÉE PAR DÉFAUT. La couverture du champ `socials` de Pulse varie
    // de 7 % (FourMeme) à 84 % (PancakeSwap) selon le launchpad : « pas de
    // réseau social » signifie souvent « Pulse ne le rapporte pas pour cette
    // source », pas « le projet n'en a pas ». Activer le gating pénaliserait
    // des chaînes entières sur un artefact de collecte — et ce biais, une fois
    // gravé dans trigger_snapshots, fausserait M5 de façon irrattrapable.
    // À réactiver quand la couverture aura été vérifiée source par source.
    const gate = t.social_gating
    if (gate?.enabled && !social.any
        && mc < (gate.mc_exempt ?? Infinity)
        && !FORT.has(reason)) {
      const floor = gate.no_social_max_tier ?? 'warm'
      const demoted = SLOWER[tier] ?? tier
      const capped = capTier(demoted, floor)
      if (capped !== tier) {
        return { tier: capped, reason: `${reason}+no_social`,
                 nextCheckMinutes: capped === 'archived' ? null : t[capped], social }
      }
    }
    return { tier, reason, nextCheckMinutes: tier === 'archived' ? null : t[tier], social }
  }

  // 1. Proche ou au-delà du plancher de MC : le capital engagé parle,
  //    l'absence de réseaux sociaux ne le contredit pas.
  if (mc >= t.hot_mc_floor) return out('hot', 'mc_floor')

  // 2. Vélocité positive constatée : le token bouge MAINTENANT — signal fort,
  //    non modulable. Un token qui trade prime sur son marketing.
  const w = token.velocity?.['5min']
  const score = w && w.buyers !== null && w.sellers !== null ? w.buyers - w.sellers : null
  if (score !== null && score > 0) return out('hot', 'velocity')

  // 3. A tradé récemment
  if (inactiveHours < t.warm_activity_hours) return out('warm', 'recent_activity')

  // 4. Inactif, mais pas encore assez longtemps pour être abandonné
  if (inactiveHours < t.archive_inactivity_hours) return out('cold', 'inactive')

  // 5. Inactif depuis longtemps ET petit : on arrête.
  //    Un token à forte capitalisation reste surveillé même silencieux —
  //    il peut se réveiller, et son abandon coûterait plus cher que son suivi.
  if (mc < t.archive_mc_ceiling) return out('archived', 'dead')

  return out('cold', 'quiet_but_large')
}

/** Signaux qui priment sur l'absence de réseaux sociaux. */
const FORT = new Set(['mc_floor', 'velocity', 'dead'])

/**
 * Le token a-t-il montré de l'activité au dernier relevé ?
 * On préfère la vélocité (wallets uniques) au volume 24 h, qui est une fenêtre
 * glissante et bouge même sans nouvelle transaction.
 */
export function hasActivity(velocity, market, previous) {
  const w = velocity?.['5min']
  if (w?.trades !== null && w?.trades !== undefined) return w.trades > 0

  const vol = market?.volume24h ?? null
  const prev = previous?.market?.volume_24h ?? null
  if (vol !== null && prev !== null) return Math.abs(vol - prev) > 0.01
  return (vol ?? 0) > 0
}

/**
 * Le `primary_pool` est le pool le plus profond, réévalué à chaque cycle :
 * la liquidité migre, et le pool de référence doit suivre.
 */
export function pickPrimaryPool(pools) {
  const active = (pools ?? []).filter(p => (p.liquidity_usd ?? p.liquidityUsd ?? 0) > 0)
  if (!active.length) return null
  return active.slice().sort((a, b) =>
    (b.liquidity_usd ?? b.liquidityUsd ?? 0) - (a.liquidity_usd ?? a.liquidityUsd ?? 0)
  )[0].address
}
