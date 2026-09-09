/**
 * Mint / freeze authority (Solana) — ownership, mint, blacklist, pause (EVM).
 * Le seul contrôle qui reste à notre charge : Mobula renvoie `security: null`
 * sur les tokens frais.
 *
 * `checked: false` (pas de RPC, contrat illisible) n'est PAS un succès :
 * on laisse passer mais on enregistre, pour que M5 puisse mesurer plus tard
 * si les tokens non contrôlés ruggent davantage.
 */
export default {
  name: 'token_security',
  blocking: true,
  cost: 'free',
  configKey: null,
  requires: ['security'],
  enabled: true,

  evaluate(ctx) {
    const s = ctx.security
    if (!s) return { value: null, passed: true, skipped: true, detail: 'non évalué' }

    if (!s.checked) {
      return { value: s.reason, passed: true, skipped: true,
               detail: `non contrôlé (${s.reason})` }
    }
    if (!s.passed) {
      return { value: s.reason, passed: false, detail: JSON.stringify(s.details).slice(0, 200) }
    }
    return { value: 'ok', passed: true }
  }
}
