/**
 * Transactions par trader unique. Un ratio élevé signe un volume fabriqué
 * par une poignée de wallets.
 */
export default {
  name: 'wash_trading',
  blocking: true,
  cost: 'free',
  configKey: 'thresholds.filters.wash_index',
  requires: ['velocity'],
  enabled: true,

  evaluate(ctx, threshold) {
    const w = ctx.velocity?.washIndex
    if (w === null || w === undefined) {
      return { value: null, passed: true, skipped: true, detail: 'indice non mesurable' }
    }
    return { value: w, passed: w < threshold }
  }
}
