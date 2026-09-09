/** Liquidité initiale minimale — écarte la masse des lancements sans fond. */
export default {
  name: 'low_liquidity',
  blocking: true,
  cost: 'free',
  configKey: 'thresholds.admission.min_liquidity_usd',
  requires: [],
  enabled: true,
  secondChance: true,   // peut se corriger : le token peut recevoir de la liquidité

  evaluate(ctx, threshold) {
    const value = ctx.listing.pool.liquidityUsd ?? 0
    return { value, passed: value >= threshold }
  }
}
