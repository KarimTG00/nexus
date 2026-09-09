/**
 * Wallets d'initiés parmi les premiers acheteurs (alimenté par M3).
 * Inactif tant que le collecteur de swaps (P7) n'a pas accumulé de données :
 * il se déclare alors `skipped`, ce qui est enregistré — un filtre inopérant
 * ne doit pas se faire passer pour un filtre qui valide.
 */
export default {
  name: 'toxic_buyers',
  blocking: true,
  cost: 'free',
  configKey: 'thresholds.admission.max_toxic_buyers',
  requires: ['toxic_buyers'],
  enabled: true,

  evaluate(ctx, threshold) {
    if (ctx.toxicBuyers === null || ctx.toxicBuyers === undefined) {
      return { value: null, passed: true, skipped: true, detail: 'M3 sans données' }
    }
    return { value: ctx.toxicBuyers, passed: ctx.toxicBuyers < (threshold ?? 2) }
  }
}
