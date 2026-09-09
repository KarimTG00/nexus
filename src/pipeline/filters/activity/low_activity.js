/**
 * Phase B de l'admission, à t+15 min : le token a-t-il attiré du monde ?
 * Lecture directe de la vélocité déjà collectée — coût nul si le token est
 * encore dans un bucket Pulse.
 */
export default {
  name: 'low_activity',
  blocking: true,
  cost: 'free',
  configKey: 'thresholds.admission',
  requires: [],
  enabled: true,
  secondChance: true,   // un token peut démarrer lentement puis s'enflammer

  evaluate(ctx, thresholds) {
    const w = ctx.listing?.velocity?.['15min'] ?? ctx.velocity?.['15min'] ?? null
    if (!w || w.trades === null) {
      return { value: null, passed: true, skipped: true, detail: 'vélocité indisponible' }
    }
    const trades = w.trades ?? 0
    const traders = w.traders ?? 0
    const passed = trades >= thresholds.min_tx_15m && traders >= thresholds.min_wallets_15m
    return {
      value: `${trades}tx/${traders}w`,
      passed,
      detail: `seuils ${thresholds.min_tx_15m}tx/${thresholds.min_wallets_15m}w`
    }
  }
}
