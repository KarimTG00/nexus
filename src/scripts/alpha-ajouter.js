/**
 * Ajoute des wallets à surveiller dans `wallet_alpha`.
 *
 * Le flux pump.fun garde chaque trade de ces wallets et la trajectoire complète
 * des tokens qu'ils touchent ; le relevé RPC garde toutes leurs transactions et
 * repère les wallets qu'ils financent. La surveillance s'arrête d'elle-même à
 * `watch_until`.
 *
 * Usage : node --env-file=.env src/scripts/alpha-ajouter.js <wallet> [<wallet>…]
 *           [--jours 2] [--groupe nom] [--note "texte"]
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'

loadEnv()
await db.connect()

const args = process.argv.slice(2)
const option = (nom, defaut) => { const i = args.indexOf(`--${nom}`); return i >= 0 ? args[i + 1] : defaut }
const jours = Number(option('jours', 2))
const groupe = option('groupe', null)
const note = option('note', null)
const wallets = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))

const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const invalides = wallets.filter(w => !base58.test(w))
if (!wallets.length || invalides.length || !(jours > 0)) {
  console.error(`usage : alpha-ajouter.js <wallet>… [--jours N] — invalides : ${invalides.join(', ') || 'aucun wallet'}`)
  process.exit(1)
}

const maintenant = new Date()
const fin = new Date(maintenant.getTime() + jours * 86_400_000)
for (const w of wallets) {
  await db.col('wallet_alpha').updateOne({ _id: w }, {
    $set: { role: 'surveille', watch_until: fin, groupe, note },
    $setOnInsert: { added_at: maintenant, last_signature: null }
  }, { upsert: true })
  console.log(`${w} surveillé jusqu'au ${fin.toISOString()}`)
}

await db.close()
