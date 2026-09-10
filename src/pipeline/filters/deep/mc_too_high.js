/**
 * Le token est-il encore assez bas pour qu'une alerte ait un sens ?
 *
 * Un palier franchi ne dit rien de la hauteur atteinte. Le système a envoyé
 * une alerte annonçant « 1 M » sur ROBIN alors que sa capitalisation valait
 * 14 M, et une autre sur OpenAI à 3,04 fois son palier. Entrer là, c'est
 * entrer après le mouvement.
 *
 * Ce filtre ne juge donc pas le palier mais la CAPITALISATION du moment. Au-
 * dessus du plafond, le token peut être excellent : il n'est simplement plus
 * capturable, et une alerte invite à acheter le sommet de quelqu'un d'autre.
 *
 * Bloquant, comme les autres filtres profonds : le snapshot conserve la valeur
 * mesurée à côté du seuil, donc M5 pourra balayer ce plafond sans recollecte.
 */
export default {
  name: 'mc_too_high',
  blocking: true,
  cost: 'free',
  configKey: 'thresholds.alert.max_mc',
  requires: [],
  enabled: true,

  evaluate(ctx, threshold) {
    const mc = ctx.mc ?? null

    if (mc === null || !Number.isFinite(mc)) {
      // Capitalisation inconnue : on ne bloque pas sur une absence de mesure,
      // et `skipped` empêche M5 de la confondre avec un vrai passage.
      return { value: null, passed: true, skipped: true, detail: 'capitalisation inconnue' }
    }

    if (!threshold) {
      return { value: mc, passed: true, skipped: true, detail: 'aucun plafond configuré' }
    }

    const ratio = ctx.threshold_franchi ? mc / ctx.threshold_franchi : null
    return {
      value: mc,
      passed: mc <= threshold,
      detail: ratio ? `${ratio.toFixed(2)}× le palier franchi` : null
    }
  }
}
