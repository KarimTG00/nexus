/**
 * Collecte des swaps EVM par ABONNEMENT `eth_subscribe`.
 *
 * C'est le seul chemin du système où le coût ne suit pas le volume de swaps.
 * Le filtre est appliqué CHEZ le fournisseur — nos adresses de tokens, le
 * sujet `Transfer` — et les journaux arrivent dans la connexion, complets.
 * Aucun appel par transaction, contrairement au sondage Solana où chaque
 * signature impose un `getTransaction`.
 *
 * Mesuré sur Robinhood Chain : 600 adresses acceptées dans un seul filtre,
 * 519 journaux reçus en vingt secondes.
 *
 * Ce que l'abonnement NE donne pas : l'horodatage du bloc. Le récupérer
 * coûterait un appel par bloc et ruinerait l'intérêt du procédé. On prend
 * l'instant de réception — le journal arrive dans la seconde qui suit le bloc,
 * et la précision utile à M2 se compte en minutes.
 */

import { col } from '../core/db/client.js'
import { statutsSurveilles } from './scope.js'
import { parseBatchEvm, grouperParTransaction, TRANSFER_TOPIC } from './parse-evm.js'
import { enregistrerSwaps } from './ingest.js'
import { mod } from '../core/logger.js'

const log = mod('collector:evm')

/** Chaînes EVM et leur sous-domaine Alchemy. */
const HOTES = {
  base: 'base-mainnet',
  bnb: 'bnb-mainnet',
  robinhood: 'robinhood-mainnet',
  ethereum: 'eth-mainnet',
  arbitrum: 'arb-mainnet'
}

const MAX_ADRESSES = 500      // mesuré : 600 passent, on garde une marge
const VIDAGE_MS = 3000        // regroupement avant écriture
const RECONNEXION_MS = 5000
const RECONNEXION_MAX_MS = 120_000
const RECONNEXIONS_MAX = 8    // au-dela, la chaine est declaree indisponible
const SEUIL_INFRA = 3         // transactions distinctes avant d etre jugee structurelle

/** Une chaîne surveillée : sa connexion, son filtre, son tampon. */
class Flux {
  constructor(chaine, wsUrl) {
    this.chaine = chaine
    this.wsUrl = wsUrl
    this.ws = null
    this.tampon = []
    this.meta = new Map()          // adresse → { decimals, pools:Set }
    this.abonnements = []
    this.arrete = false
    this.stats = { logs: 0, swaps: 0, positions: 0, reconnexions: 0, erreurs: 0 }
    this.minuteur = null

    // Mémoire d'infrastructure, PERSISTANTE entre les lots.
    //
    // La détecter dans un seul lot ne suffit pas : avec deux journaux, un pool
    // n'apparaît qu'une fois et passe sous le seuil. C'est arrivé au premier
    // essai — le PoolManager d'Uniswap V4 sur Base a été enregistré comme un
    // trader. Une adresse structurelle se révèle par sa RÉCURRENCE dans le
    // temps, pas dans l'instant.
    this.vus = new Map()          // adresse → nombre de transactions distinctes
    this.infra = new Set()
    this.attente = RECONNEXION_MS
  }

  /** Recense les adresses d'un lot et promeut celles qui reviennent. */
  apprendre(parTx) {
    for (const logs of parTx.values()) {
      const dansCetteTx = new Set()
      for (const l of logs) {
        dansCetteTx.add(('0x' + l.topics[1].slice(26)).toLowerCase())
        dansCetteTx.add(('0x' + l.topics[2].slice(26)).toLowerCase())
      }
      for (const a of dansCetteTx) {
        const n = (this.vus.get(a) ?? 0) + 1
        this.vus.set(a, n)
        if (n >= SEUIL_INFRA) this.infra.add(a)
      }
    }
    // Borne mémoire : au-delà, on oublie les adresses vues une seule fois,
    // qui sont par définition des traders et non de l'infrastructure.
    if (this.vus.size > 200_000) {
      for (const [a, n] of this.vus) if (n < 2) this.vus.delete(a)
    }
  }

  async chargerMeta(cfg) {
    const docs = await col('tokens').find(
      { chain: this.chaine, status: { $in: statutsSurveilles(cfg, this.chaine) } },
      { projection: { address: 1, decimals: 1, 'pools.address': 1 } }
    ).toArray()

    this.meta = new Map(docs.map(d => [String(d.address).toLowerCase(), {
      decimals: d.decimals ?? 18,
      pools: new Set((d.pools ?? []).map(p => String(p.address).toLowerCase()))
    }]))
    return [...this.meta.keys()]
  }

  connecter(adresses) {
    if (this.arrete) return
    this.ws = new WebSocket(this.wsUrl)

    this.ws.addEventListener('open', () => {
      // Le filtre est découpé : une adresse de trop ferait refuser TOUT
      // l'abonnement, donc toute la chaîne, pour un seul token en trop.
      this.attente = RECONNEXION_MS
      this.abonnements = []
      for (let i = 0; i < adresses.length; i += MAX_ADRESSES) {
        const tranche = adresses.slice(i, i + MAX_ADRESSES)
        this.ws.send(JSON.stringify({
          jsonrpc: '2.0', id: 1 + i / MAX_ADRESSES, method: 'eth_subscribe',
          params: ['logs', { address: tranche, topics: [TRANSFER_TOPIC] }]
        }))
      }
      log.info({ chaine: this.chaine, adresses: adresses.length,
        filtres: Math.ceil(adresses.length / MAX_ADRESSES) }, 'abonnement EVM ouvert')
    })

    this.ws.addEventListener('message', ev => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }

      if (m.error) { this.stats.erreurs++; log.warn({ chaine: this.chaine, err: m.error.message }, 'abonnement refuse'); return }
      if (m.result && m.id !== undefined) { this.abonnements.push(m.result); return }

      const l = m.params?.result
      if (!l) return
      this.stats.logs++
      this.tampon.push(l)
      if (!this.minuteur) this.minuteur = setTimeout(() => this.vider(), VIDAGE_MS)
    })

    this.ws.addEventListener('close', () => {
      if (this.arrete) return
      this.stats.reconnexions++

      // Une chaine non activee chez le fournisseur refuse la connexion
      // instantanement : sans recul ni abandon, on boucle. Observe sur BNB,
      // huit tentatives en quarante-cinq secondes pour un reseau simplement
      // pas active sur l application Alchemy.
      if (this.stats.reconnexions > RECONNEXIONS_MAX) {
        this.arrete = true
        log.error({ chaine: this.chaine, tentatives: this.stats.reconnexions },
          'chaine indisponible — abandon. Verifier qu elle est activee chez le fournisseur.')
        return
      }

      log.warn({ chaine: this.chaine, reconnexions: this.stats.reconnexions,
        dans_ms: this.attente }, 'connexion perdue — reprise')
      setTimeout(() => this.connecter(adresses), this.attente)
      this.attente = Math.min(RECONNEXION_MAX_MS, this.attente * 2)
    })

    this.ws.addEventListener('error', e => {
      this.stats.erreurs++
      log.warn({ chaine: this.chaine, err: e.message ?? 'erreur' }, 'WebSocket en erreur')
    })
  }

  async vider() {
    this.minuteur = null
    if (!this.tampon.length) return
    const lot = this.tampon.splice(0, this.tampon.length)

    try {
      // L'instant de réception fait office d'horodatage : voir l'entête.
      const ts = Date.now()
      const horodatages = new Map()
      for (const l of lot) horodatages.set(l.blockNumber, ts)

      // On apprend d abord : une adresse deja connue comme structurelle est
      // ainsi ecartee des ce lot, sans attendre qu elle se repete a nouveau.
      const parTx = grouperParTransaction(lot)
      this.apprendre(parTx)

      // L infrastructure accumulee est fournie a chaque token, en plus de ses
      // pools connus — dont on a constate qu ils sont parfois faux (un token
      // Robinhood listait sa propre adresse comme pool).
      const metaEnrichie = new Map()
      for (const [adr, m] of this.meta) {
        metaEnrichie.set(adr, { ...m, pools: new Set([...m.pools, ...this.infra]) })
      }

      const swaps = parseBatchEvm(lot, metaEnrichie, horodatages)
      this.stats.swaps += swaps.length
      if (swaps.length) {
        const r = await enregistrerSwaps(swaps, { chain: this.chaine })
        this.stats.positions += r.positions
      }
    } catch (e) {
      this.stats.erreurs++
      log.error({ chaine: this.chaine, err: e.message, lot: lot.length }, 'lot EVM en echec')
    }
  }

  fermer() {
    this.arrete = true
    clearTimeout(this.minuteur)
    try { this.ws?.close() } catch { /* deja ferme */ }
  }
}

const flux = new Map()

/**
 * Ouvre ou réaligne les abonnements EVM.
 *
 * Appelée périodiquement : la liste de tokens vit — promotions, archivages —
 * et un filtre figé cesserait progressivement de couvrir ce qu'on suit.
 */
export async function syncEvm(cfg) {
  const stats = { chaines: 0, adresses: 0, flux: {} }

  if (!cfg?.features?.swap_collector?.enabled) {
    return { ...stats, skipped: true, reason: 'collecteur desactive' }
  }
  if (!process.env.ALCHEMY_KEY) {
    return { ...stats, skipped: true, reason: 'ALCHEMY_KEY absente' }
  }

  const actives = Object.entries(cfg.features?.chains ?? {})
    .filter(([, v]) => v)
    .map(([id]) => id)

  for (const [chaine, hote] of Object.entries(HOTES)) {
    // On ne s'abonne qu'aux chaînes activées dans la configuration.
    const idMobula = chaine === 'base' ? 'evm:8453' : chaine === 'bnb' ? 'evm:56'
      : chaine === 'robinhood' ? 'evm:4663' : chaine === 'ethereum' ? 'evm:1' : 'evm:42161'
    if (!actives.includes(idMobula)) continue

    let f = flux.get(chaine)
    if (!f) {
      f = new Flux(chaine, `wss://${hote}.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`)
      flux.set(chaine, f)
    }

    const adresses = await f.chargerMeta(cfg)
    if (!adresses.length) continue

    // Réabonnement : on referme et on rouvre plutôt que de tenir un différentiel
    // par filtre. Le coût est une reconnexion, pas des appels facturés.
    if (f.ws) { try { f.ws.close() } catch { /* deja ferme */ } }
    f.arrete = false
    f.connecter(adresses)

    stats.chaines++
    stats.adresses += adresses.length
    stats.flux[chaine] = { adresses: adresses.length, ...f.stats }
  }

  return stats
}

export function statsEvm() {
  return Object.fromEntries([...flux].map(([c, f]) => [c, { ...f.stats, tampon: f.tampon.length }]))
}

export function arreterEvm() {
  for (const f of flux.values()) f.fermer()
  flux.clear()
}
