/**
 * De vrais acheteurs arrivent-ils par-dessus l'activité fabriquée ?
 *
 * `micro_trades` détecte la fabrication ; celui-ci détecte si elle prend. Un
 * déployeur qui arrose son token de micro-achats ne gagne rien tant que
 * personne ne le suit — et c'est le cas de la grande majorité : 95 % des
 * tokens pump.fun ne graduent jamais.
 *
 * On compte donc les WALLETS DISTINCTS qui achètent au-dessus du seuil de
 * micro-trade sur 5 minutes. Un wallet, pas une transaction : celui qui
 * répète cinquante achats compte pour un, comme n'importe quel autre.
 *
 * Seuil à 0 par défaut : pendant l'étude, on mesure sans bloquer. Rien ne dit
 * encore quel effectif sépare une montée d'une mort, et un seuil posé au
 * jugé nous priverait des exemples qui l'auraient appris.
 */

import { CONFIG_V1 } from '../../../core/config/defaults.js'

const DEFAUT = CONFIG_V1.thresholds.stream.min_real_buyers_5m

export default {
  name: 'real_buyers',
  blocking: true,
  cost: 'free',
  configKey: 'thresholds.stream.min_real_buyers_5m',
  requires: [],
  enabled: true,

  evaluate(ctx, threshold) {
    const seuil = threshold ?? DEFAUT
    const n = ctx.live?.real_buyers_5m

    if (n === null || n === undefined) {
      return { value: null, threshold: seuil, passed: true, skipped: true, detail: 'montants en dollars inconnus' }
    }
    return {
      value: n,
      // Le seuil appliqué, même quand il vaut 0 : à zéro le filtre mesure sans
      // bloquer, et M5 doit voir que c'est un choix, pas une absence.
      threshold: seuil,
      passed: n >= seuil,
      detail: `${n} acheteurs au-dessus de ${ctx.live?.micro_usd ?? '?'} $ sur 5 min`
    }
  }
}
