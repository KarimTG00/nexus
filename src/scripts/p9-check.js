/**
 * Validation de la phase P9.
 *
 * Critère (docs/roadmap.md) : le rapport d'angles morts sort, et le tableau
 * d'efficacité des filtres est lisible.
 *
 * L'échantillon sera famélique tant que le pipeline n'aura pas tourné une
 * semaine — c'est attendu. Ce qu'on valide ici, c'est que les CALCULS sont
 * justes, en les éprouvant sur des jeux de données fabriqués.
 *
 * Usage : npm run p9
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { col } from '../core/db/client.js'
import { active } from '../core/config/store.js'
import { efficacy, sweep, redundancy } from '../analytics/m5-calibration.js'
import { topGainers } from '../analytics/m7-blindspots.js'

const ok = s => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const ko = s => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const warn = s => console.log(`  \x1b[33m!\x1b[0m ${s}`)

/** Jeu synthétique : un bon filtre, un mauvais, et un doublon du mauvais. */
function jeuTest() {
  const rows = []
  for (let i = 0; i < 100; i++) {
    // `bon_filtre` rejette 40 tokens dont AUCUN ne réussit → il protège.
    // `mauvais_filtre` rejette 40 tokens dont 12 réussissent → il coûte.
    const rejeteBon = i < 40
    const rejeteMauvais = i >= 30 && i < 70
    const reussit = rejeteBon ? false : (i >= 55 && i < 80)

    rows.push({
      _id: 'x' + i,
      decision: (rejeteBon || rejeteMauvais) ? 'rejected' : 'alerted',
      rugged: false,
      multiple: reussit ? 8 : 1.2,
      filters: [
        { name: 'bon_filtre', value: i, threshold: 40, passed: !rejeteBon },
        { name: 'mauvais_filtre', value: i, threshold: 70, passed: !rejeteMauvais },
        // identique au mauvais → doit ressortir comme doublon
        { name: 'doublon', value: i, threshold: 70, passed: !rejeteMauvais }
      ]
    })
  }
  return rows
}

async function main() {
  loadEnv()
  await db.connect(); await cache.connect()
  const cfg = await active()
  let allOk = true

  console.log('\n\x1b[1mValidation P9 — boucle analytique\x1b[0m\n')

  // --- 1. Efficacité : sait-on distinguer un bon filtre d'un mauvais ? -----
  console.log('1. M5 — efficacité des filtres')
  const rows = jeuTest()
  const eff = efficacy(rows, { successMultiple: 5 })

  const bon = eff.filtres.find(f => f.filtre === 'bon_filtre')
  const mauvais = eff.filtres.find(f => f.filtre === 'mauvais_filtre')

  ok(`référence : ${eff.reference.alertes} alertés, ${(eff.reference.taux_succes * 100).toFixed(0)}% de succès`)

  const bonOk = bon.taux === 0 && bon.verdict === 'bon filtre'
  const mauvaisOk = mauvais.taux > 0 && mauvais.verdict === 'ne discrimine pas'
  ;(bonOk ? ok : ko)(`bon_filtre     : ${bon.rejetes} rejetés, ${(bon.taux * 100).toFixed(0)}% réussissent → « ${bon.verdict} »`)
  ;(mauvaisOk ? ok : ko)(`mauvais_filtre : ${mauvais.rejetes} rejetés, ${(mauvais.taux * 100).toFixed(0)}% réussissent → « ${mauvais.verdict} »`)
  if (!bonOk || !mauvaisOk) allOk = false
  ok('un filtre dont les rejets réussissent autant que les alertés ne protège de rien')

  // --- 2. Balayage de seuil ------------------------------------------------
  console.log('\n2. M5 — balayage de seuil')
  const sw = sweep(rows, 'bon_filtre', [20, 40, 60, 80, 100], { direction: 'above', successMultiple: 5 })

  // Avec `direction: 'above'`, un seuil plus haut laisse passer MOINS de
  // tokens : la courbe doit décroître. (Elle croîtrait avec 'below'.)
  const monotone = sw.courbe.every((c, i, a) => i === 0 || c.alertes <= a[i - 1].alertes)
  ;(monotone && sw.courbe.length === 5 ? ok : ko)(
    `5 seuils rejoués sur ${sw.echantillon} décisions, sans un seul appel réseau`)
  if (!monotone) allOk = false
  for (const c of sw.courbe) {
    console.log(`      seuil ${String(c.seuil).padStart(4)} → ${String(c.alertes).padStart(3)} alertes, ` +
      `${c.taux !== null ? (c.taux * 100).toFixed(0) + '%' : '—'} de succès`)
  }
  ok('possible uniquement parce que la VALEUR MESURÉE est stockée, pas un booléen')

  // --- 3. Redondance -------------------------------------------------------
  console.log('\n3. M5 — redondance')
  const red = redundancy(rows)
  const paire = red.find(p => p.filtres.includes('mauvais_filtre') && p.filtres.includes('doublon'))
  ;(paire?.doublon ? ok : ko)(
    `doublon détecté : ${paire?.filtres.join(' ≡ ')} — recouvrement ${(paire?.recouvrement * 100).toFixed(0)}%`)
  if (!paire?.doublon) allOk = false
  const distincts = red.find(p => p.filtres.includes('bon_filtre') && p.filtres.includes('doublon'))
  ;(distincts && !distincts.doublon ? ok : ko)(
    `filtres distincts non signalés : recouvrement ${(distincts?.recouvrement * 100).toFixed(0)}%`)

  // --- 4. M7 : le filtre d'âge -------------------------------------------
  console.log('\n4. M7 — filtre d\'âge sur les meilleures performances')
  const recents = await topGainers(cfg, { limit: 20, maxAgeDays: 7 })
  const anciens = await topGainers(cfg, { limit: 20, maxAgeDays: 3650 })
  const ageMed = a => {
    const v = a.filter(x => x.createdAt).map(x => (Date.now() - x.createdAt) / 3_600_000).sort((p, q) => p - q)
    return v.length ? v[Math.floor(v.length / 2)] : null
  }
  const mr = ageMed(recents), ma = ageMed(anciens)
  ok(`sans filtre : ${anciens.length} tokens, âge médian ${ma ? (ma / 24).toFixed(0) + 'j' : '—'}`)
  ok(`avec filtre : ${recents.length} tokens, âge médian ${mr ? mr.toFixed(1) + 'h' : '—'}`)
  const filtreUtile = mr !== null && ma !== null && mr < ma
  ;(filtreUtile ? ok : warn)(
    filtreUtile
      ? 'le filtre écarte bien les vieux tokens qui pompent — sans lui, le taux de capture est mesuré sur la mauvaise population'
      : 'écart non mesurable à cet instant')

  // --- 5. Rapports persistés ----------------------------------------------
  console.log('\n5. Rapports en base')
  const bs = await col('analytics_blindspots').findOne({}, { sort: { period: -1 } })
  const fp = await col('analytics_filter_perf').findOne({}, { sort: { period: -1 } })

  ;(bs ? ok : ko)(bs
    ? `angles morts ${bs.period} : ${bs.echantillon} tokens, capture ${(bs.taux_capture * 100).toFixed(0)}%, ` +
      `${bs.ventilation.jamais_decouvert} jamais découverts`
    : 'aucun rapport d\'angles morts')
  ;(fp ? ok : ko)(fp
    ? `calibration ${fp.period} : ${fp.decisions} décisions avec verdict`
    : 'aucun rapport de calibration')
  if (!bs || !fp) allOk = false

  if (fp && fp.decisions < 30) {
    warn(`échantillon réel de ${fp.decisions} décisions — les verdicts demandent 7 jours par token, ` +
      'les chiffres ne seront exploitables qu\'après une semaine de fonctionnement continu')
  }

  // --- 6. Le dashboard ne calcule rien ------------------------------------
  console.log('\n6. Collections pré-calculées')
  for (const c of ['analytics_blindspots', 'analytics_filter_perf', 'analytics_funnel']) {
    const n = await col(c).countDocuments()
    ;(n > 0 ? ok : warn)(`${c.padEnd(24)} ${n} période(s)`)
  }
  ok('le dashboard lira ces documents — aucune agrégation à la volée (P10)')

  console.log(allOk
    ? '\n\x1b[1m\x1b[32mP9 validée.\x1b[0m\n'
    : '\n\x1b[1m\x1b[31mP9 NON validée.\x1b[0m\n')
  process.exitCode = allOk ? 0 : 1
}

main()
  .catch(e => { console.error('\nÉchec :', e.message, '\n', e.stack); process.exitCode = 1 })
  .finally(async () => { await db.close(); await cache.close() })
