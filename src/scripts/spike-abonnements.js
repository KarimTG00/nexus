/**
 * Quelles méthodes d'abonnement un fournisseur accepte-t-il réellement ?
 *
 * Les pages tarifaires listent « WebSocket » sans dire lesquelles. Or l'écart
 * entre `blockSubscribe` et `logsSubscribe` change le coût d'un ordre de
 * grandeur : le premier livre les transactions complètes et supprime tout
 * `getTransaction`, le second ne donne que des signatures et en impose un par
 * swap. On teste donc, on ne lit pas.
 *
 * Usage : node --env-file=.env src/scripts/spike-abonnements.js [fournisseur]
 */

import { loadEnv } from '../core/env.js'
import { fournisseur } from '../adapters/rpc/providers.js'

// Un mint actif, pour que `logsSubscribe` ait de quoi répondre.
const MINT = 'ocqb1GLWsj6moUCkdJj4C4sVtNXLW8Y1eWHpT4qpump'
// Le programme AMM de pump.fun : un seul abonnement couvrirait tous ses swaps.
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'

const METHODES = [
  { nom: 'blockSubscribe (all)', m: 'blockSubscribe',
    p: ['all', { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 }],
    interet: 'transactions completes, zero getTransaction' },
  { nom: 'blockSubscribe (programme)', m: 'blockSubscribe',
    p: [{ mentionsAccountOrProgram: PUMP_AMM }, { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 }],
    interet: 'idem, limite a un DEX — bande passante bien moindre' },
  { nom: 'logsSubscribe (mint)', m: 'logsSubscribe',
    p: [{ mentions: [MINT] }, { commitment: 'confirmed' }],
    interet: 'un abonnement par mint, puis un getTransaction par swap' },
  { nom: 'logsSubscribe (programme)', m: 'logsSubscribe',
    p: [{ mentions: [PUMP_AMM] }, { commitment: 'confirmed' }],
    interet: 'un seul abonnement pour tout un DEX, toujours un getTransaction par swap' },
  { nom: 'accountSubscribe', m: 'accountSubscribe',
    p: [MINT, { commitment: 'confirmed', encoding: 'jsonParsed' }],
    interet: 'variations de compte, pas de swaps' },
  { nom: 'programSubscribe', m: 'programSubscribe',
    p: [PUMP_AMM, { commitment: 'confirmed', encoding: 'jsonParsed' }],
    interet: 'comptes du programme, pas de transactions' },
  { nom: 'slotSubscribe', m: 'slotSubscribe', p: [],
    interet: 'battement, sert de temoin que le WebSocket fonctionne' }
]

async function main() {
  loadEnv()
  const f = fournisseur(process.argv[2] || null)
  if (!f) { console.error('\nAucun fournisseur configuré.\n'); process.exit(1) }

  console.log(`\n\x1b[1mMéthodes d'abonnement acceptées — ${f.nom}\x1b[0m`)
  console.log(`facturation en ${f.cost_unit ?? 'unité inconnue'}\n`)

  const ws = new WebSocket(f.wsUrl)
  const attentes = new Map()
  let premierMessage = null

  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.id && attentes.has(m.id)) {
      attentes.get(m.id)(m)
      attentes.delete(m.id)
    } else if (m.method) {
      premierMessage ??= m.method   // une notification est arrivée : ça vit
    }
  })

  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', e => rej(new Error(e.message ?? 'connexion refusée')))
  })
  console.log('connexion WebSocket établie\n')

  let id = 0
  const accepte = []
  for (const t of METHODES) {
    const monId = ++id
    const reponse = await new Promise(res => {
      attentes.set(monId, res)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: monId, method: t.m, params: t.p }))
      setTimeout(() => { if (attentes.delete(monId)) res({ timeout: true }) }, 8000)
    })

    const ok = reponse.result !== undefined && !reponse.error
    if (ok) accepte.push(t.nom)
    const etat = reponse.timeout ? '\x1b[33mpas de réponse\x1b[0m'
      : ok ? '\x1b[32mACCEPTÉE\x1b[0m'
      : `\x1b[31mrefusée\x1b[0m (${reponse.error?.code} ${reponse.error?.message})`
    console.log(`  ${t.nom.padEnd(28)} ${etat}`)
    console.log(`  ${''.padEnd(28)} ${t.interet}`)
  }

  // Laisse une chance à une notification d'arriver : une méthode peut être
  // acceptée sans jamais rien livrer, ce qui revient au même qu'un refus.
  await new Promise(r => setTimeout(r, 6000))
  console.log(`\nnotifications reçues pendant l'essai : ${premierMessage ?? 'aucune'}`)

  console.log('\n\x1b[1mConclusion\x1b[0m')
  if (accepte.some(n => n.startsWith('blockSubscribe'))) {
    console.log('  blockSubscribe disponible — le coût peut cesser de suivre le volume.')
  } else if (accepte.some(n => n.startsWith('logsSubscribe'))) {
    console.log('  Seul logsSubscribe est ouvert : un getTransaction par swap reste')
    console.log('  nécessaire, donc le coût demeure proportionnel au volume.')
  } else {
    console.log('  Aucune méthode exploitable pour la collecte de swaps.')
  }
  ws.close()
}

main().catch(e => { console.error('\nÉchec :', e.message); process.exitCode = 1 })
