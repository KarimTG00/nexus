/**
 * Note finale suffisante pour alerter ?
 *
 * Ce contrôle existait déjà, écrit en dur dans l'étage de déclenchement. Le
 * déclarer comme filtre lui donne ce que les autres ont : une ligne dans
 * `filters[]` du snapshot, une valeur mesurée à côté de son seuil, et donc la
 * possibilité pour M5 de balayer ce seuil a posteriori sans rien recollecter.
 *
 * Il s'exécute APRÈS les filtres `deep`, puisqu'il consomme leur produit : le
 * score agrège pente, vélocité, liquidité, sécurité et social.
 *
 * `name` reste `low_score` — c'est la valeur historique de `rejection_reason`,
 * la renommer couperait la continuité des snapshots déjà écrits.
 */
export default {
  name: 'low_score',
  blocking: true,
  cost: 'free',
  configKey: 'thresholds.alert.min_score',
  requires: [],
  enabled: true,

  evaluate(ctx, threshold) {
    if (ctx.score === null || ctx.score === undefined) {
      // Aucun sous-score disponible : ce n'est pas un score faible, c'est une
      // absence de mesure. On bloque quand même — alerter sans rien avoir su
      // mesurer serait pire — mais `value: null` empêche M5 de le confondre
      // avec un vrai rejet sur seuil.
      return { value: null, passed: false, detail: 'aucun sous-score disponible' }
    }

    return {
      value: ctx.score,
      passed: ctx.score >= threshold,
      detail: `couverture ${Math.round((ctx.coverage ?? 0) * 100)} %`
    }
  }
}
