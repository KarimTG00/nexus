/**
 * Repère — et, si on le lui demande, supprime — les données produites par des
 * événements ÉTRANGERS au flux pump.fun.
 *
 * Cause : un discriminant Anchor est le hachage du seul NOM de l'événement.
 * Un autre programme Solana nommant le sien `TradeEvent` produit donc le même
 * préfixe de huit octets, et ses événements étaient décodés avec la grammaire
 * de pump.fun. Observé sur des transactions d'agrégateurs, qui appellent
 * plusieurs programmes dans la même transaction.
 *
 * Symptôme : une adresse qui n'est pas un mint, une capitalisation à 93 M et
 * une liquidité à 263 milliards. La correction (attribution par pile d'appels)
 * empêche que ça se reproduise ; ce script traite ce qui est déjà écrit.
 *
 * Le test est le seul qui ne se discute pas : on demande à la chaîne si
 * l'adresse est un mint. `getTokenSupply` répond « not a Token mint » quand
 * elle ne l'est pas.
 *
 * Par défaut le script ne fait que MARQUER (`live.invalide`) et compter.
 * Ajouter `--supprimer` efface les documents concernés.
 *
 * Usage :
 *   node --env-file=.env src/scripts/nettoyer-fantomes.js
 *   node --env-file=.env src/scripts/nettoyer-fantomes.js --supprimer
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import { col } from '../core/db/client.js'

const RPC = 'https://api.mainnet-beta.solana.com'
const supprimer = process.argv.includes('--supprimer')

const pause = ms => new Promise(r => setTimeout(r, ms))

async function estUnMint(address) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [address] })
  })
  const j = await r.json()
  if (j.error) {
    // « Invalid param: not a Token mint » est une réponse, pas une panne.
    if (/not a Token mint|Invalid param/i.test(j.error.message)) return false
    throw new Error(j.error.message)
  }
  return Boolean(j.result?.value)
}

loadEnv()
await db.connect()

// On ne teste que les tokens du flux : le reste vient de Mobula, qui ne
// fabrique pas d'adresses.
const candidats = await col('tokens').find(
  { 'live.source': 'stream' },
  { projection: { address: 1, symbol: 1, 'live.mc': 1, 'live.complet': 1, 'live.invalide': 1 } }
).toArray()

console.log(`${candidats.length} tokens du flux à vérifier sur la chaîne`)

const fantomes = []
let verifies = 0
for (const t of candidats) {
  try {
    if (!(await estUnMint(t.address))) fantomes.push(t)
    verifies++
  } catch (e) {
    console.log(`  ${t.address.slice(0, 10)}… non vérifiable : ${e.message}`)
  }
  await pause(120)   // le RPC public est gratuit, on ne le martèle pas
}

console.log(`\nvérifiés ${verifies} | adresses qui ne sont pas des mints : ${fantomes.length}`)
for (const f of fantomes.slice(0, 15)) {
  console.log(`  ${f.address.slice(0, 12)}… ${String(f.symbol ?? '?').padEnd(8)} mc ${Math.round(f.live?.mc ?? 0).toLocaleString()}`)
}
if (!fantomes.length) { await db.close(); process.exit(0) }

const ids = fantomes.map(f => f._id)
const compte = {
  trades: await col('trades').countDocuments({ token: { $in: ids } }),
  snapshots: await col('trigger_snapshots').countDocuments({ token: { $in: ids } }),
  alertes: await col('alerts').countDocuments({ token: { $in: ids } }),
  outcomes: await col('outcomes').countDocuments({ token: { $in: ids } })
}
console.log(`\ndocuments liés : ${JSON.stringify(compte)}`)

// Marquage, toujours : même conservés, ces documents ne doivent plus jamais
// être comptés comme des mesures de marché.
await col('tokens').updateMany(
  { _id: { $in: ids } },
  { $set: { status: 'archived', tier: 'archived', archived_at: new Date(),
            rejection_reason: 'evenement_etranger', 'live.invalide': true } }
)
console.log(`${ids.length} tokens marqués invalides et archivés`)

if (!supprimer) {
  console.log('\nrien n\'a été supprimé. Relancer avec --supprimer pour effacer '
    + 'ces tokens et leurs documents liés.')
} else {
  const r = {
    trades: (await col('trades').deleteMany({ token: { $in: ids } })).deletedCount,
    snapshots: (await col('trigger_snapshots').deleteMany({ token: { $in: ids } })).deletedCount,
    alertes: (await col('alerts').deleteMany({ token: { $in: ids } })).deletedCount,
    outcomes: (await col('outcomes').deleteMany({ token: { $in: ids } })).deletedCount,
    tokens: (await col('tokens').deleteMany({ _id: { $in: ids } })).deletedCount
  }
  console.log(`supprimés : ${JSON.stringify(r)}`)
}

await db.close()
