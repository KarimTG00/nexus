/**
 * Corrige le volume de trades écrits dans la configuration ACTIVE.
 *
 * La version active porte un bloc `thresholds.stream` complet, copié des
 * défauts de l'époque avec `control_permille: 1000` : il l'emporte sur les
 * défauts du code, si bien que la correction 44ef164 (témoin à 20 ‰, plafond
 * par token) n'avait aucun effet en production. Mesuré : 185 000 trades en
 * 55 minutes, soit ~2,5 Go par jour pour un volume de 4,6 Go.
 *
 * Ne touche QUE ces deux clés : les autres nouveautés du flux (entrée
 * organique à 20 K, seuils mesurés) supposent le code qui les lit, et une
 * entrée à 20 K sans la condition « organique » alerterait n'importe quoi.
 *
 * Usage : node --env-file=.env src/scripts/stream-volume-config.js
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import { active, createVersion, get } from '../core/config/store.js'
import { CONFIG_V1 } from '../core/config/defaults.js'

loadEnv()
await db.connect()

const cfg = await active({ force: true })
const D = CONFIG_V1.thresholds.stream
const voulu = [
  ['thresholds.stream.control_permille', D.control_permille],
  ['thresholds.stream.study_max_trades', D.study_max_trades]
]
const changes = voulu
  .filter(([path, to]) => get(cfg, path, null) !== to)
  .map(([path, to]) => ({ path, to, source: 'manual' }))

if (!changes.length) {
  console.log(`version ${cfg._id} : volume de trades déjà corrigé, rien à faire`)
} else {
  const v = await createVersion(changes, {
    createdBy: 'manual',
    note: 'Trades : témoin à 20 ‰ et plafond par token — la version précédente écrivait tous les trades'
  })
  console.log(`version ${v._id} créée : ${changes.map(c => `${c.path} → ${c.to}`).join(', ')}`)
}

await db.close()
