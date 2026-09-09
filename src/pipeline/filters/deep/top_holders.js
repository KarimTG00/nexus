/**
 * Concentration du top 10, hors pools de liquidité.
 * Fourni directement par Pulse (`top10HoldingsPercentage`) — gratuit.
 */
export default {
  name: 'top_holders',
  blocking: true,
  cost: 'free',
  configKey: 'thresholds.filters.top_holders',
  requires: ['holders'],
  enabled: true,

  evaluate(ctx, threshold) {
    const v = ctx.holders?.top10Pct
    if (v === null || v === undefined) {
      return { value: null, passed: true, skipped: true, detail: 'top10 indisponible' }
    }
    return { value: +v.toFixed(2), passed: v < threshold }
  }
}
