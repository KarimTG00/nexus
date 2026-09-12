/**
 * Bascule la configuration en mode « flux temps réel, Solana seul ».
 *
 * Crée une NOUVELLE version à partir de l'active, avec un diff tracé — jamais
 * une modification en place. Chaque changement n'est appliqué que s'il diffère
 * de la valeur courante, donc le script est rejouable sans effet.
 *
 * Ce qu'il fait, et pourquoi :
 *   - active le flux et ses réglages (ils existent déjà par défaut dans le
 *     code ; les écrire ici les rend visibles dans l'historique des versions,
 *     là où M5 et le dashboard les lisent) ;
 *   - coupe les chaînes EVM : le flux ne couvre que pump.fun, et l'EVM était
 *     la seule raison qui restait d'utiliser Alchemy ;
 *   - coupe le sondage RPC des swaps : le flux livre chaque trade pump.fun
 *     gratuitement, sonder les mêmes tokens serait payer pour relire.
 *
 * Usage : node --env-file=.env src/scripts/stream-config.js
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import { active, createVersion, get } from '../core/config/store.js'
import { CONFIG_V1 } from '../core/config/defaults.js'

loadEnv()
await db.connect()

const cfg = await active({ force: true })

const voulu = [
  ['features.stream', CONFIG_V1.features.stream],
  ['thresholds.stream', CONFIG_V1.thresholds.stream],
  // Solana seul : mesuré, pump.fun représente 77,6 % de nos tokens Solana et
  // 64 % de ceux qui dépassent 50 K. Le reste est assumé comme abandonné.
  ['features.chains', { ...cfg.features.chains, 'evm:8453': false, 'evm:1': false,
    'evm:56': false, 'evm:42161': false, 'evm:4663': false }],
  ['features.swap_collector', { ...cfg.features.swap_collector, enabled: false }]
]

const memeValeur = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const changes = voulu
  .filter(([path, to]) => !memeValeur(get(cfg, path, null), to))
  .map(([path, to]) => ({ path, to, source: 'manual' }))

if (!changes.length) {
  console.log(`version ${cfg._id} : déjà en mode flux Solana seul, rien à faire`)
} else {
  const v = await createVersion(changes, {
    createdBy: 'manual',
    note: 'Flux temps réel pump.fun, Solana seul : entrée à 50 K, micro-trades, '
      + 'sorties échelonnées, filtres en mesure seule, EVM et sondage coupés'
  })
  console.log(`version ${v._id} créée :`)
  for (const c of changes) console.log(`  ${c.path}`)
}

await db.close()
