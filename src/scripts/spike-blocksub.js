/**
 * Sonde : `blockSubscribe` est-il utilisable, et que consomme-t-il vraiment ?
 *
 * La question qu'on tranche ici décide de l'architecture du collecteur.
 *
 *   logsSubscribe  un abonnement par mint, puis UN getTransaction par swap.
 *                  Le coût reste proportionnel au volume de swaps — même
 *                  modèle que Helius, qui a épuisé 1 M de crédits en un jour.
 *
 *   blockSubscribe un seul abonnement, transactions COMPLÈTES incluses dans
 *                  le bloc, zéro getTransaction. Le coût cesse de dépendre du
 *                  nombre de swaps. Si c'est disponible, on peut rétablir le
 *                  périmètre large et récupérer les 81 % d'entrées
 *                  pré-promotion que le périmètre étroit sacrifie.
 *
 * `blockSubscribe` est une méthode instable de Solana : elle exige que le
 * validateur ait été démarré avec `--rpc-pubsub-enable-block-subscription`.
 * Beaucoup de fournisseurs ne l'activent pas. On ne le saura qu'en essayant —
 * d'où cette sonde plutôt qu'une lecture de documentation.
 *
 * Usage :
 *   node --env-file=.env src/scripts/spike-blocksub.js [minutes] [fournisseur]
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import { col } from '../core/db/client.js'
import { fournisseur } from '../adapters/rpc/providers.js'
import { parseTransactionRpc } from '../collector/parse-rpc.js'
import { statutsSurveilles, SURVEILLES_LARGE } from '../collector/scope.js'

const minutes = Number(process.argv[2]) || 5
const idFournisseur = process.argv[3] || null

const ok = s => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const ko = s => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const info = s => console.log(`    ${s}`)

async function main() {
  loadEnv()

  const f = fournisseur(idFournisseur)
  if (!f) {
    console.error('\nAucun fournisseur configuré.')
    console.error('Ajouter une des variables suivantes dans .env :')
    console.error('  ALCHEMY_KEY     la clé du projet Solana Alchemy')
    console.error('  QUICKNODE_URL   l\'URL complète du point d\'accès QuickNode')
    console.error('  ANKR_KEY        la clé Ankr\n')
    process.exit(1)
  }

  console.log(`\n\x1b[1mSonde blockSubscribe — ${f.nom}, ${minutes} min\x1b[0m`)
  console.log(`unité de facturation : ${f.cost_unit ?? 'inconnue'}\n`)

  await db.connect()

  // Les deux périmètres, pour chiffrer ce que coûterait le retour au large.
  const etroit = new Set((await col('tokens').find(
    { chain: 'solana', status: { $in: statutsSurveilles(null) } },
    { projection: { address: 1 } }).toArray()).map(d => d.address))
  const large = new Set((await col('tokens').find(
    { chain: 'solana', status: { $in: SURVEILLES_LARGE } },
    { projection: { address: 1 } }).toArray()).map(d => d.address))

  console.log(`périmètre étroit : ${etroit.size} mints | large : ${large.size} mints\n`)

  const stats = {
    blocs: 0, transactions: 0, octets: 0,
    swapsEtroit: 0, swapsLarge: 0,
    walletsEtroit: new Set(), walletsLarge: new Set(),
    premierBloc: null, dernierBloc: null, erreur: null
  }

  const fin = await mesurer(f, stats, minutes * 60_000, { etroit, large })

  console.log('\n\x1b[1mRésultat\x1b[0m')
  if (stats.erreur) {
    ko(`blockSubscribe indisponible : ${stats.erreur}`)
    info('Repli : logsSubscribe par mint, avec un getTransaction par swap.')
    info('Le coût redevient proportionnel au volume — relancer la sonde sur un')
    info('autre fournisseur avant de conclure.')
  } else if (!stats.blocs) {
    ko('abonnement accepté, aucun bloc reçu')
    info('Souvent le signe d\'une méthode acceptée mais non alimentée.')
  } else {
    ok(`${stats.blocs} blocs reçus, ${stats.transactions} transactions`)
    ok(`${(stats.octets / 1048576).toFixed(1)} Mo reçus en ${(fin / 60_000).toFixed(1)} min`)
    info(`soit ~${(stats.octets / 1048576 / (fin / 3600_000)).toFixed(0)} Mo/heure`)

    console.log('\n  swaps captés sur nos mints :')
    info(`périmètre étroit : ${stats.swapsEtroit} swaps, ${stats.walletsEtroit.size} wallets`)
    info(`périmètre large  : ${stats.swapsLarge} swaps, ${stats.walletsLarge.size} wallets`)
    const parJour = n => Math.round(n / (fin / 86400_000))
    info(`projection : ${parJour(stats.swapsEtroit)} et ${parJour(stats.swapsLarge)} swaps/jour`)

    console.log('\n  \x1b[1mCe qu\'il faut lire sur le tableau de bord du fournisseur\x1b[0m')
    info(`la consommation des ${(fin / 60_000).toFixed(0)} dernières minutes,`)
    info(`à comparer à ${stats.transactions} transactions traitées sans un seul`)
    info('getTransaction. C\'est ce rapport qui décide, pas le nombre de crédits.')
  }
  console.log()
}

/** Ouvre l'abonnement et mesure. Résout avec la durée réellement écoulée. */
function mesurer(f, stats, dureeMs, { etroit, large }) {
  return new Promise(resolve => {
    const t0 = Date.now()
    let ws
    try { ws = new WebSocket(f.wsUrl) }
    catch (e) { stats.erreur = e.message; return resolve(Date.now() - t0) }

    const terminer = () => {
      try { ws.close() } catch { /* déjà fermé */ }
      resolve(Date.now() - t0)
    }
    const minuteur = setTimeout(terminer, dureeMs)

    ws.addEventListener('open', () => {
      console.log('connexion établie, demande d\'abonnement…')
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'blockSubscribe',
        params: ['all', {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0,
          showRewards: false
        }]
      }))
    })

    ws.addEventListener('message', ev => {
      const brut = typeof ev.data === 'string' ? ev.data : ''
      stats.octets += brut.length

      let m
      try { m = JSON.parse(brut) } catch { return }

      if (m.error) {
        stats.erreur = `${m.error.code} ${m.error.message}`
        clearTimeout(minuteur)
        return terminer()
      }
      if (m.id === 1 && m.result !== undefined) {
        ok(`abonnement accepté (id ${m.result}) — collecte en cours…`)
        return
      }

      const bloc = m.params?.result?.value?.block
      if (!bloc) return

      stats.blocs++
      stats.premierBloc ??= bloc.blockHeight
      stats.dernierBloc = bloc.blockHeight

      for (const tx of bloc.transactions ?? []) {
        stats.transactions++
        // Le bloc porte la transaction complète : blockTime vit sur le bloc.
        const enrichie = { ...tx, blockTime: bloc.blockTime }

        for (const s of parseTransactionRpc(enrichie, null)) {
          if (large.has(s.mint)) { stats.swapsLarge++; stats.walletsLarge.add(s.wallet) }
          if (etroit.has(s.mint)) { stats.swapsEtroit++; stats.walletsEtroit.add(s.wallet) }
        }
      }

      if (stats.blocs % 25 === 0) {
        process.stdout.write(`    ${stats.blocs} blocs | ${stats.transactions} tx | `
          + `${stats.swapsLarge} swaps (large) | ${(stats.octets / 1048576).toFixed(0)} Mo\n`)
      }
    })

    ws.addEventListener('error', e => {
      stats.erreur = e.message ?? 'erreur de connexion WebSocket'
      clearTimeout(minuteur)
      terminer()
    })

    ws.addEventListener('close', () => { clearTimeout(minuteur); resolve(Date.now() - t0) })
  })
}

main()
  .catch(e => { console.error('\nÉchec :', e.message, '\n', e.stack); process.exitCode = 1 })
  .finally(async () => { await db.close() })
