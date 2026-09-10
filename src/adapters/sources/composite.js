/**
 * Source composite — route chaque appel vers la source la mieux placée,
 * avec repli automatique.
 *
 * Le pipeline ne sait pas qui répond : il appelle `getTokenMarkets()` et
 * reçoit une réponse normalisée. C'est exactement ce que l'interface
 * DataSource + capabilities était censée permettre (docs/architecture.md).
 *
 * Répartition, fondée sur les mesures :
 *   découverte, lot de marché  → Mobula seul (Pulse ; 50 tokens pour 1 crédit)
 *   pools et liquidité         → Mobula d'abord, DexScreener en repli
 *
 * Motif du repli : `token/markets` de Mobula a renvoyé 25, 16, 3, 4 puis 0
 * pools sur des appels identiques. DexScreener a répondu à chaque fois.
 */

import { CAP } from '../../core/types/datasource.js'
import { mod } from '../../core/logger.js'

const log = mod('source:composite')

export class CompositeSource {
  constructor(primary, secondary) {
    this.name = `${primary.name}+${secondary.name}`
    this.primary = primary
    this.secondary = secondary
    this.capabilities = new Set([...primary.capabilities, ...secondary.capabilities])
    this.fallbacks = 0
  }

  // --- délégué sans repli : Mobula est seul à savoir faire ------------------
  //
  // ⚠️ Toute méthode absente ici est INVISIBLE pour le pipeline, sans erreur.
  // `getNewListingsPost` manquait : `discovery.js` teste sa présence avant de
  // l'appeler, le test échouait, et la découverte repliait sur le GET paginé
  // à CHAQUE cycle. La voie POST — 10 vues pour 1 crédit — n'a jamais servi en
  // production, alors que le GET consomme jusqu'à un crédit par page et par
  // chaîne. Le seul signe était un avertissement « POST sans résultat », qui
  // décrivait un appel qui n'avait pas eu lieu.
  getNewListingsPost(...a) { return this.primary.getNewListingsPost(...a) }
  getNewListings(...a) { return this.primary.getNewListings(...a) }
  getMarketData(...a) { return this.primary.getMarketData(...a) }

  /**
   * Pools et liquidité, avec repli.
   * Une réponse vide n'est PAS une réponse valide : on tente la secondaire.
   */
  async getTokenMarkets(ref, opts) {
    let primary = null
    try {
      primary = await this.primary.getTokenMarkets(ref, opts)
    } catch (e) {
      log.debug({ token: ref.address, err: e.message }, 'source primaire en échec')
    }

    if (primary?.pools?.length) {
      return { ...primary, source: this.primary.name }
    }

    this.fallbacks++
    log.debug({ token: ref.address }, 'repli sur la source secondaire')
    try {
      const fb = await this.secondary.getTokenMarkets(ref, opts)
      return { ...fb, source: this.secondary.name, fellBack: true }
    } catch (e) {
      log.warn({ token: ref.address, err: e.message }, 'les deux sources ont échoué')
      return primary ?? { pools: [], aggregated: {}, source: null }
    }
  }

  /**
   * Les deux mesures de liquidité, côte à côte — voir docs/face1-pipeline.md.
   *
   *   consensus  ce que FOMO, DexScreener et les agrégateurs affichent.
   *              C'est ce que voient les autres traders, donc ce qui guide
   *              leur comportement. À afficher dans l'alerte.
   *   aggregate  la somme des pools : la profondeur réellement tradable.
   *              À utiliser pour les filtres.
   *
   * Mesuré : l'écart va de 2x à 15x selon les tokens — ce n'est pas une
   * conversion d'unité, `market/data` ne couvre qu'un sous-ensemble de pools.
   */
  async getLiquidityProfile(ref, marketData = null) {
    const markets = await this.getTokenMarkets(ref)
    const consensus = marketData?.liquidityUsd ?? null
    const aggregate = markets.aggregated?.liquidityUsd ?? null

    return {
      consensus,
      aggregate,
      divergence: consensus && aggregate ? +(aggregate / consensus).toFixed(2) : null,
      primaryShare: markets.aggregated?.primaryShare ?? null,
      poolCount: markets.aggregated?.activePoolCount ?? null,
      source: markets.source,
      measured_at: new Date(),
      markets
    }
  }

  async stats() {
    return {
      primary: await this.primary.stats(),
      secondary: await this.secondary.stats(),
      fallbacks: this.fallbacks
    }
  }

  drainFailures() {
    return [...this.primary.drainFailures(), ...this.secondary.drainFailures()]
  }
}
