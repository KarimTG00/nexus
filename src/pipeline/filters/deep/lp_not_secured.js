/**
 * La liquidité est-elle protégée ? LP brûlée, verrouillée, ou protocolaire.
 *
 * ⚠️ `liquidityBurnPercentage` vaut `null` sur certaines chaînes — mesuré sur
 * Robinhood en uniswap-v4. Une absence de donnée n'est PAS un échec : on
 * marque `skipped`, sinon on éliminerait mécaniquement des chaînes entières.
 * Même règle que pour `security.checked`.
 */
export default {
  name: 'lp_not_secured',
  blocking: true,
  cost: 'paid',
  configKey: 'thresholds.filters.lp_secured',
  requires: ['liquidity'],
  enabled: true,

  evaluate(ctx, threshold) {
    const burn = ctx.liquidity?.liquidityBurnPct
    const bonded = ctx.bonding?.bonded

    // Liquidité protocolaire : un token gradué a vu sa LP prise en charge par
    // le launchpad, il n'y a pas de dev pour la retirer.
    if (burn === null || burn === undefined) {
      if (bonded) return { value: 'protocolaire', passed: true, detail: 'gradué, LP protocolaire' }
      return { value: null, passed: true, skipped: true, detail: 'donnée absente sur cette chaîne' }
    }
    return { value: +burn.toFixed(2), passed: burn >= threshold }
  }
}
