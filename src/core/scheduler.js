/**
 * Ordonnanceur de cycles.
 *
 * Trois protections, chacune imposée par un constat de terrain :
 *
 *  1. ANTI-CHEVAUCHEMENT — un cycle de découverte prend 15 à 90 s. Sans verrou,
 *     un cycle lent en croiserait un autre et on paierait deux fois les mêmes
 *     crédits.
 *
 *  2. ISOLATION DES ÉTAGES — un étage en échec ne doit pas emporter le cycle.
 *     La découverte parcourt les chaînes dans l'ordre : sans isolation, un
 *     incident sur Solana priverait systématiquement Robinhood, traitée en
 *     dernier.
 *
 *  3. BATTEMENT DE CŒUR — la fenêtre Pulse ne remonte qu'à ~3 h. Un worker
 *     mort en silence pendant une nuit, c'est une nuit de lancements perdue
 *     définitivement. On veut le savoir, pas le découvrir.
 */

import { mod } from './logger.js'

const log = mod('scheduler')

export class Scheduler {
  constructor({ onError } = {}) {
    this.tasks = new Map()
    this.stopping = false
    this.onError = onError ?? (() => {})
  }

  /**
   * @param {string} name
   * @param {number} intervalMs
   * @param {Function} fn        reçoit un signal d'arrêt
   * @param {Object} opts        { runOnStart }
   */
  every(name, intervalMs, fn, { runOnStart = true } = {}) {
    const task = {
      name, intervalMs, fn,
      running: false, timer: null,
      runs: 0, errors: 0, skipped: 0, overruns: 0,
      nextDue: Date.now(),
      lastStart: null, lastEnd: null, lastDurationMs: null, lastError: null
    }
    this.tasks.set(name, task)

    const tick = async () => {
      if (this.stopping) return

      // REPLANIFIER D'ABORD, exécuter ensuite.
      //
      // Cette ligne se trouvait après `await fn()`. Un cycle qui ne rendait
      // jamais la main — une opération sans délai maximal — ne l'atteignait
      // donc pas : plus aucun timer n'était armé et la tâche mourait en
      // silence, processus toujours vivant. Observé en production : cycle 269
      // terminé proprement en 34 s, puis plus rien pendant une heure, service
      // affiché « Online ». Armer le timer avant l'exécution fait survivre la
      // cadence à un blocage ; l'anti-chevauchement ci-dessous empêche
      // l'empilement.
      task.nextDue += intervalMs
      let wait = task.nextDue - Date.now()
      if (wait < 0) {
        task.overruns++
        task.nextDue = Date.now() + intervalMs
        wait = intervalMs
        log.warn({ tache: name, depassements: task.overruns, dureeMs: task.lastDurationMs },
          'cycle plus long que son intervalle')
      }
      task.timer = setTimeout(tick, Math.max(0, wait))

      // Anti-chevauchement : on saute plutôt que d'empiler
      if (task.running) {
        task.skipped++
        // Un cycle encore en cours après plusieurs intervalles n'est plus lent :
        // il est bloqué. Le dire explicitement évite de lire « cycle sauté »
        // pendant des heures sans comprendre que rien n'avance.
        const depuis = task.lastStart ? Date.now() - task.lastStart.getTime() : 0
        if (depuis > 3 * intervalMs) {
          log.error({ tache: name, bloqueDepuisMin: +(depuis / 60_000).toFixed(1), sautes: task.skipped },
            'cycle bloqué — aucune progression depuis plusieurs intervalles')
        } else {
          log.warn({ tache: name, sautes: task.skipped }, 'cycle précédent encore en cours — cycle sauté')
        }
      } else {
        task.running = true
        task.lastStart = new Date()
        const t0 = Date.now()
        try {
          await fn()
          task.runs++
          task.lastError = null
        } catch (e) {
          task.errors++
          task.lastError = e.message
          log.error({ tache: name, err: e.message }, 'cycle en échec')
          this.onError(name, e)
        } finally {
          task.running = false
          task.lastEnd = new Date()
          task.lastDurationMs = Date.now() - t0
        }
      }

      // La cadence reste FIXE : l'échéance suivante a été calculée en entrée
      // de tick, jamais depuis la fin du traitement. Replanifier depuis la fin
      // ajouterait la durée du cycle à chaque tour — 110 s de traitement plus
      // 300 s d'attente donnent 410 s réels, et le rythme dérive.
    }

    task.nextDue = Date.now() + (runOnStart ? 0 : intervalMs)
    if (runOnStart) setImmediate(tick)
    else task.timer = setTimeout(tick, intervalMs)

    log.info({ tache: name, intervalleMin: intervalMs / 60_000 }, 'tâche planifiée')
    return this
  }

  /** Exécute des étapes en isolant leurs échecs : une qui tombe n'arrête pas les suivantes. */
  static async runStages(stages) {
    const results = {}
    for (const [name, fn] of Object.entries(stages)) {
      try {
        results[name] = await fn()
      } catch (e) {
        results[name] = { error: e.message }
        log.error({ etage: name, err: e.message }, 'étage en échec — le cycle continue')
      }
    }
    return results
  }

  status() {
    return [...this.tasks.values()].map(t => ({
      name: t.name,
      running: t.running,
      runs: t.runs, errors: t.errors, skipped: t.skipped, overruns: t.overruns,
      lastStart: t.lastStart, lastDurationMs: t.lastDurationMs, lastError: t.lastError,
      // Silencieux depuis plus de 3 intervalles : le worker est probablement mort
      stalled: t.lastEnd ? (Date.now() - t.lastEnd) > t.intervalMs * 3 : false
    }))
  }

  async stop() {
    this.stopping = true
    for (const t of this.tasks.values()) if (t.timer) clearTimeout(t.timer)
    // On laisse les cycles en cours se terminer : couper au milieu d'une
    // écriture de trigger_snapshot perdrait une décision irremplaçable.
    const encours = [...this.tasks.values()].filter(t => t.running)
    if (encours.length) {
      log.info({ taches: encours.map(t => t.name) }, 'attente de la fin des cycles en cours')
      const deadline = Date.now() + 60_000
      while ([...this.tasks.values()].some(t => t.running) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500))
      }
    }
    log.info('ordonnanceur arrêté')
  }
}
