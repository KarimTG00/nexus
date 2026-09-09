/**
 * Formatage.
 *
 * Règle héritée du bot Telegram : une donnée absente s'affiche « — », jamais
 * un zéro. Un trou de collecte ne doit pas ressembler à une mesure.
 */

const absent = v => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))

export const usd = v => {
  if (absent(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(2) + ' Md$'
  if (a >= 1e6) return (v / 1e6).toFixed(2) + ' M$'
  if (a >= 1e3) return Math.round(v / 1e3) + ' K$'
  return Math.round(v) + ' $'
}

export const num = (v, d = 0) =>
  absent(v) ? '—' : v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })

export const pct = (v, d = 1) => (absent(v) ? '—' : v.toFixed(d) + ' %')

export const signed = v => (absent(v) ? '—' : (v > 0 ? '+' : '') + v)

export const age = iso => {
  if (!iso) return '—'
  const min = (Date.now() - new Date(iso).getTime()) / 60000
  if (min < 0) return '—'
  if (min < 60) return `${Math.round(min)} min`
  if (min < 1440) return `${Math.floor(min / 60)} h`
  const j = Math.floor(min / 1440)
  return j < 30 ? `${j} j` : `${Math.floor(j / 30)} mois`
}

export const heure = iso => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—')

export const dateHeure = iso =>
  iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

export const CHAINES = {
  solana: { nom: 'Solana', teinte: '#9945FF' },
  base: { nom: 'Base', teinte: '#0052FF' },
  bnb: { nom: 'BNB', teinte: '#F0B90B' },
  robinhood: { nom: 'Robinhood', teinte: '#00C805' },
  ethereum: { nom: 'Ethereum', teinte: '#627EEA' },
  arbitrum: { nom: 'Arbitrum', teinte: '#28A0F0' }
}

export const STATUTS = {
  discovered: { label: 'découvert', ton: 'faint' },
  pending_activity: { label: 'en attente', ton: 'info' },
  tracked: { label: 'suivi', ton: 'accent' },
  triggered: { label: 'déclenché', ton: 'warn' },
  alerted: { label: 'alerté', ton: 'up' },
  quarantine: { label: 'quarantaine', ton: 'warn' },
  archived: { label: 'archivé', ton: 'faint' }
}

export const VERDICTS = {
  SUCCESS: { label: 'succès', ton: 'up' },
  SURVIVED: { label: 'survit', ton: 'info' },
  DEAD: { label: 'mort', ton: 'faint' },
  RUGGED: { label: 'rug pull', ton: 'down' },
  PENDING: { label: 'en cours', ton: 'dim' }
}

export const explorateur = (chain, address) => {
  const c = { solana: 'solana', base: 'base', bnb: 'bsc', robinhood: 'robinhood' }[chain]
  return c ? `https://dexscreener.com/${c}/${address}` : null
}

export const court = a => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—')
