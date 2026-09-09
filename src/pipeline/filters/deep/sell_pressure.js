/** Les acheteurs dominent-ils encore les vendeurs ? */
export default {
  name: 'sell_pressure',
  blocking: true,
  cost: 'free',
  configKey: 'thresholds.filters.sell_pressure',
  requires: ['velocity'],
  enabled: true,

  evaluate(ctx, threshold) {
    const r = ctx.velocity?.buySellRatio
    if (r === null || r === undefined) {
      return { value: null, passed: true, skipped: true, detail: 'ratio non mesurable' }
    }
    return { value: r === Infinity ? 999 : r, passed: r >= threshold }
  }
}
