/**
 * Le token fabrique-t-il son activité ?
 *
 * Signature relevée à la main sur un token alerté : le déployeur fait vivre
 * son token par une pluie de micro-achats (0,20 à 0,50 $). Le nombre de
 * transactions et de holders gonfle, le token remonte sur les plateformes de
 * listing, et de vrais acheteurs arrivent. C'est cette phase, AVANT l'arrivée
 * des vrais acheteurs, que la stratégie vise.
 *
 * Une proportion plutôt qu'un ticket moyen : un seul gros achat fausse une
 * moyenne, pas une proportion.
 *
 * Mesuré sur chaque trade du flux temps réel. Mobula ne fournit que des
 * agrégats (nombre d'achats, volume), où la signature est invisible.
 *
 * Bloquant : la stratégie cible précisément ces tokens. Tant que l'échantillon
 * est trop petit, le filtre s'abstient (`skipped`) plutôt que de conclure sur
 * trois trades — et M5 distingue ainsi une abstention d'un vrai passage.
 */

import { CONFIG_V1 } from '../../../core/config/defaults.js'

const DEFAUT = CONFIG_V1.thresholds.stream.micro_share

export default {
  name: 'micro_trades',
  blocking: true,
  cost: 'free',
  configKey: 'thresholds.stream.micro_share',
  requires: [],
  enabled: true,

  evaluate(ctx, threshold) {
    const seuil = threshold ?? DEFAUT
    const part = ctx.live?.micro_share ?? null
    const n = ctx.live?.micro_sample ?? 0
    const min = ctx.live?.min_sample ?? 0

    if (part === null) {
      return { value: null, threshold: seuil, passed: true, skipped: true, detail: 'montants en dollars inconnus' }
    }
    const value = +part.toFixed(3)
    if (n < min) {
      return { value, threshold: seuil, passed: true, skipped: true, detail: `${n} trades mesurés, ${min} requis` }
    }
    return {
      value,
      // Le seuil appliqué, y compris quand il vient du code faute de clé en
      // configuration : c'est lui que M5 devra balayer.
      threshold: seuil,
      passed: part >= seuil,
      detail: `${Math.round(part * 100)} % des ${n} trades sous le seuil`
    }
  }
}
