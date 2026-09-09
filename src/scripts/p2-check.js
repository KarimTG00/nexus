/**
 * Validation de la phase P2.
 *
 * Critère (docs/roadmap.md) : des tokens entrent dans `tokens` au bon statut,
 * et l'entonnoir quotidien est cohérent.
 *
 * Usage : npm run p2
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { col } from '../core/db/client.js'
import { active, enabledChains } from '../core/config/store.js'
import { fromMobula } from '../core/chains.js'
import { adapterStatus } from '../adapters/chains/index.js'
import { loadFilters, filtersFor, requirementsFor } from '../pipeline/filters/index.js'
import { discover } from '../pipeline/stages/discovery.js'
import { admit, checkActivity } from '../pipeline/stages/admission.js'
import { getSource } from '../adapters/sources/index.js'

const ok = s => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const ko = s => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const warn = s => console.log(`  \x1b[33m!\x1b[0m ${s}`)

async function main() {
  loadEnv()
  await db.connect()
  await cache.connect()
  const cfg = await active()
  const chains = enabledChains(cfg).map(fromMobula).filter(Boolean)

  console.log('\n\x1b[1mValidation P2 — découverte et admission\x1b[0m\n')

  // --- 1. Registre de filtres ---------------------------------------------
  console.log('1. Registre de filtres')
  await loadFilters({ force: true })
  for (const stage of ['admission', 'activity']) {
    const list = await filtersFor(stage)
    const reqs = await requirementsFor(stage)
    ok(`${stage.padEnd(10)} ${list.map(f => f.name).join(' → ')}`)
    console.log(`               requires : ${reqs.join(', ') || 'aucun'}`)
  }

  // --- 2. Adapters de chaîne ----------------------------------------------
  console.log('\n2. Adapters de sécurité')
  for (const s of adapterStatus(chains)) {
    ;(s.securityAvailable ? ok : warn)(
      `${s.chain.padEnd(10)} famille ${s.family.padEnd(7)} ` +
      (s.securityAvailable ? 'contrôle actif' : 'AUCUN RPC — sécurité non contrôlée'))
  }

  // --- 3. Découverte -------------------------------------------------------
  console.log('\n3. Découverte (étage 0)')
  const before = await col('tokens').countDocuments()
  const { candidates, stats: d } = await discover(cfg)
  ok(`${d.vus} tokens vus sur ${chains.length} chaînes`)
  ok(`connus ${d.connus} (dont ${d.poolsAjoutes} nouveaux pools) | déjà rejetés ${d.rejetesConnus}`)
  ok(`nouveaux ${d.nouveaux} | seconde chance ${d.secondeChance}`)

  // --- 4. Admission --------------------------------------------------------
  console.log('\n4. Admission phase A (étage 1)')
  const a = await admit(candidates, cfg)
  ok(`${a.evalues} évalués → ${a.admis} admis`)
  const rejets = Object.entries(a.rejetes).sort((x, y) => y[1] - x[1])
  for (const [reason, n] of rejets) {
    console.log(`      ${String(n).padStart(4)}  ${reason}`)
  }

  // --- 5. Phase B ----------------------------------------------------------
  console.log('\n5. Admission phase B — contrôle d\'activité')
  const b = await checkActivity(cfg)
  ok(`${b.evalues} échus → ${b.promus} promus, ${b.reportes} reportés, ${b.archives} archivés, ${b.sansDonnees} sans données`)
  if (b.evalues === 0) console.log('      (normal au premier passage : échéance à t+15 min)')

  // --- 6. État de la base --------------------------------------------------
  console.log('\n6. État de la base')
  const after = await col('tokens').countDocuments()
  const byStatus = await col('tokens').aggregate([
    { $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }
  ]).toArray()
  const byChain = await col('tokens').aggregate([
    { $group: { _id: '$chain', n: { $sum: 1 } } }, { $sort: { n: -1 } }
  ]).toArray()
  const rejCount = await col('rejected_seen').countDocuments()

  ok(`tokens : ${before} → ${after} (+${after - before})`)
  ok(`statuts : ${byStatus.map(s => `${s._id}=${s.n}`).join(' ')}`)
  ok(`chaînes : ${byChain.map(s => `${s._id}=${s.n}`).join(' ')}`)
  ok(`rejected_seen : ${rejCount}`)

  // Vérification de forme sur un document réel
  const sample = await col('tokens').findOne({ status: 'pending_activity' })
  if (sample) {
    console.log(`\n  exemple : ${sample.symbol ?? '?'} (${sample._id})`)
    const checks = {
      'config_version': sample.config_version != null,
      'schema_version': sample.schema_version != null,
      'pools[]': Array.isArray(sample.pools) && sample.pools.length > 0,
      'primary_pool': Boolean(sample.primary_pool),
      'next_check_at': sample.next_check_at instanceof Date,
      'security.checked': 'checked' in (sample.security ?? {}),
      'candidates{}': Object.keys(sample.candidates ?? {}).length > 0,
      'admission_filters[]': Array.isArray(sample.admission_filters)
    }
    for (const [k, v] of Object.entries(checks)) (v ? ok : ko)(`champ ${k}`)
    const secOk = sample.security?.checked
    ;(secOk ? ok : warn)(`sécurité ${secOk ? 'contrôlée' : 'NON contrôlée : ' + sample.security?.reason}`)
  } else {
    warn('aucun token en pending_activity à inspecter')
  }

  // --- 7. Rejets : la valeur mesurée est-elle stockée ? --------------------
  console.log('\n7. Traçabilité des rejets (indispensable à M5)')
  const rej = await col('rejected_seen').findOne({ value: { $ne: null } })
  if (rej) {
    ok(`exemple : ${rej.reason} — valeur ${rej.value} vs seuil ${rej.threshold}`)
    ok(`filtres tracés : ${rej.filters?.length ?? 0} | seconde chance : ${rej.next_retry_at ? 'oui' : 'non'}`)
  } else {
    warn('aucun rejet avec valeur mesurée')
  }

  const srcStats = await getSource(cfg).stats()
  console.log(`\n  crédits Mobula : ${srcStats.used}/${srcStats.budget}`)

  const passed = after > before && byStatus.length > 0
  console.log(passed
    ? '\n\x1b[1m\x1b[32mP2 validée.\x1b[0m\n'
    : '\n\x1b[1m\x1b[31mP2 NON validée.\x1b[0m\n')
  process.exitCode = passed ? 0 : 1
}

main()
  .catch(e => { console.error('\nÉchec :', e.message, '\n', e.stack); process.exitCode = 1 })
  .finally(async () => { await db.close(); await cache.close() })
