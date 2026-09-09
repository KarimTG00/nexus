/**
 * Le token accélère-t-il ?
 * Lu sur les fenêtres imbriquées d'un seul appel — pas besoin de trois relevés.
 */
export default {
  name: 'flat_velocity',
  blocking: true,
  cost: 'free',
  configKey: null,
  requires: ['velocity'],
  enabled: true,

  evaluate(ctx) {
    const a = ctx.velocity?.acceleration
    if (!a || a.direction === null) {
      return { value: null, passed: true, skipped: true, detail: 'vélocité non mesurable' }
    }
    if (!a.confident) {
      // Effectif trop faible : le ratio est du bruit. On ne rejette pas sur
      // du bruit, mais on l'enregistre pour que M5 puisse trancher plus tard.
      return { value: a.ratio, passed: true, skipped: true, detail: 'effectif insuffisant' }
    }
    return { value: a.ratio, passed: a.direction === 'up', detail: a.direction }
  }
}
