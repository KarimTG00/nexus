/**
 * Passe `micro_trades` en mesure seule dans la configuration active.
 *
 * Mesuré : 217 entrées sur 217 rejetées par ce filtre en 12 h — part de
 * micro-trades médiane à 11 %, jamais au-dessus de 57 %, pour un seuil à
 * 70 %. Plus aucune alerte ne pouvait partir. Sa valeur reste enregistrée
 * dans chaque snapshot : M10 continue de la mesurer, elle ne bloque plus.
 *
 * Crée une nouvelle version avec un diff tracé ; rejouable sans effet.
 *
 * Usage : node --env-file=.env src/scripts/stream-micro-mesure-config.js
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import { active, createVersion, get } from '../core/config/store.js'

loadEnv()
await db.connect()

const cfg = await active({ force: true })
const chemin = 'thresholds.stream.measure_only_filters'
const actuels = get(cfg, chemin, [])

if (actuels.includes('micro_trades')) {
  console.log(`version ${cfg._id} : micro_trades déjà en mesure seule, rien à faire`)
} else {
  const v = await createVersion([{ path: chemin, to: ['micro_trades', ...actuels], source: 'manual' }], {
    createdBy: 'manual',
    note: 'micro_trades en mesure seule : 217 rejets sur 217 entrées en 12 h'
  })
  console.log(`version ${v._id} créée : ${chemin} → ${JSON.stringify(['micro_trades', ...actuels])}`)
}

await db.close()
