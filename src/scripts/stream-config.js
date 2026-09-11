/**
 * Active le flux temps réel dans la configuration : crée une NOUVELLE version
 * à partir de l'active, avec un diff tracé — jamais une modification en place.
 *
 * Le flux tourne déjà sans cette version, sur les valeurs par défaut de
 * defaults.js. Ce script les rend explicites et visibles dans l'historique
 * des versions, là où M5 et le dashboard les lisent.
 *
 * Usage : node --env-file=.env src/scripts/stream-config.js
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import { active, createVersion } from '../core/config/store.js'
import { CONFIG_V1 } from '../core/config/defaults.js'

loadEnv()
await db.connect()

const cfg = await active({ force: true })
const changes = []
if (!cfg.features?.stream) {
  changes.push({ path: 'features.stream', to: CONFIG_V1.features.stream, source: 'manual' })
}
if (!cfg.thresholds?.stream) {
  changes.push({ path: 'thresholds.stream', to: CONFIG_V1.thresholds.stream, source: 'manual' })
}

if (!changes.length) {
  console.log(`version ${cfg._id} : le flux est déjà configuré, rien à faire`)
} else {
  const v = await createVersion(changes, {
    createdBy: 'manual',
    note: 'Flux temps réel pump.fun : entrée à 50 K, micro-trades, sorties ×10 et auteurs'
  })
  console.log(`version ${v._id} créée :`, changes.map(c => c.path).join(', '))
}

await db.close()
