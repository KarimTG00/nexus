/**
 * Active l'entrée ORGANIQUE à 20 K et les seuils mesurés dans la configuration.
 *
 * À lancer APRÈS le déploiement du code qui lit ces réglages : la version
 * active porte un bloc `thresholds.stream` complet qui l'emporte sur les
 * défauts du code, donc sans cette version les nouveautés restent inertes.
 * Et avant ce code, une entrée à 20 K sans la condition « organique »
 * partirait sur n'importe quel token.
 *
 * Crée une nouvelle version avec un diff tracé ; rejouable sans effet.
 *
 * Usage : node --env-file=.env src/scripts/stream-organique-config.js
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import { active, createVersion, get } from '../core/config/store.js'
import { CONFIG_V1 } from '../core/config/defaults.js'

loadEnv()
await db.connect()

const cfg = await active({ force: true })
const D = CONFIG_V1.thresholds.stream
const voulu = ['entry_mc', 'organic_only', 'organic_min_age_seconds', 'factory_max_seconds', 'measure_mc']
  .map(k => [`thresholds.stream.${k}`, D[k]])

const memeValeur = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const changes = voulu
  .filter(([path, to]) => !memeValeur(get(cfg, path, null), to))
  .map(([path, to]) => ({ path, to, source: 'manual' }))

if (!changes.length) {
  console.log(`version ${cfg._id} : entrée organique déjà active, rien à faire`)
} else {
  const v = await createVersion(changes, {
    createdBy: 'manual',
    note: 'Entrée organique à 20 K sur la courbe, usine observée, seuils mesurés 10 K à 30 K'
  })
  console.log(`version ${v._id} créée :`)
  for (const c of changes) console.log(`  ${c.path} → ${JSON.stringify(c.to)}`)
}

await db.close()
