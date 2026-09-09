/**
 * Déployeur ou cluster blacklisté (alimenté par M4).
 * Jamais bloquant pour un déployeur inconnu : c'est la majorité des cas,
 * et absence d'historique ne vaut pas mauvaise réputation.
 */
export default {
  name: 'blacklisted_deployer',
  blocking: true,
  cost: 'free',
  configKey: null,
  requires: ['deployer_reputation'],
  enabled: true,

  evaluate(ctx) {
    const rep = ctx.deployerRep
    if (!rep) return { value: 'inconnu', passed: true }
    if (rep.blacklisted) {
      return { value: rep.blacklist_reason ?? 'blacklisté', passed: false,
               detail: `${rep.n_rugged}/${rep.n_launches} rugs` }
    }
    return { value: `${rep.n_rugged}/${rep.n_launches} rugs`, passed: true }
  }
}
