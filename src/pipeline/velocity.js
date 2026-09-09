/**
 * Vélocité — le signal central du bot.
 *
 * Le score d'intérêt est `acheteurs uniques − vendeurs uniques` sur une fenêtre.
 * Mobula fournit ces wallets distincts par fenêtre (1min, 5min, 15min, 1h, 24h).
 *
 * La PENTE se lit dans un seul appel : en ramenant chaque fenêtre à un taux
 * par minute, on compare l'instant présent au passé proche sans attendre trois
 * relevés successifs. C'est plus rapide et moins cher que le design initial.
 *
 * Toute métrique absente reste `null` — jamais 0. Une source qui ne distingue
 * pas les wallets (DexScreener) ne doit pas produire un score qui ressemble à
 * une mesure.
 */

/** Minutes couvertes par chaque fenêtre. */
const SPAN = { '1min': 1, '5min': 5, '15min': 15, '1h': 60, '24h': 1440 }

const num = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v))

/** Score d'intérêt d'une fenêtre : entrants nets. */
export function interestScore(w) {
  const b = num(w?.buyers), s = num(w?.sellers)
  return b !== null && s !== null ? b - s : null
}

/** Taux par minute, pour rendre deux fenêtres de durées différentes comparables. */
function perMinute(w, field) {
  const v = num(w?.[field])
  return v === null ? null : v / (SPAN[w?.__span] ?? 1)
}

/**
 * Accélération : compare le rythme récent au rythme plus large.
 *
 * @returns {{ direction, ratio, rates, confident }}
 *   direction  'up' | 'flat' | 'down' | null si non mesurable
 *   ratio      rythme court / rythme long (1 = stable)
 *   confident  false quand les effectifs sont trop faibles pour conclure
 */
export function acceleration(velocity, { field = 'buyers', minSample = 5 } = {}) {
  const rate = win => {
    const w = velocity?.[win]
    const v = num(w?.[field])
    return v === null ? null : { rate: v / SPAN[win], count: v }
  }

  const short = rate('5min')
  const long = rate('1h') ?? rate('15min')

  if (!short || !long || long.rate === 0) {
    return { direction: null, ratio: null, rates: { short: short?.rate ?? null, long: long?.rate ?? null }, confident: false }
  }

  const ratio = short.rate / long.rate
  // Sous un certain effectif, le ratio est du bruit : 1 acheteur sur 5 min
  // contre 2 sur une heure « accélère » de 6x sans rien signifier.
  const confident = long.count >= minSample

  const direction = ratio >= 1.2 ? 'up' : ratio <= 0.8 ? 'down' : 'flat'
  return { direction, ratio: +ratio.toFixed(2), rates: { short: short.rate, long: long.rate }, confident }
}

/** Équilibre achats/ventes sur une fenêtre. */
export function buySellRatio(w) {
  const b = num(w?.buys), s = num(w?.sells)
  if (b === null || s === null) return null
  if (s === 0) return b > 0 ? Infinity : null
  return +(b / s).toFixed(2)
}

/**
 * Indice de wash : transactions par trader unique.
 * 200 achats faits par 4 wallets n'est pas la même chose que par 187.
 */
export function washIndex(w) {
  const t = num(w?.trades), u = num(w?.traders)
  if (t === null || u === null || u === 0) return null
  return +(t / u).toFixed(2)
}

/** Instantané complet de vélocité pour une fenêtre donnée. */
export function velocitySnapshot(velocity, window = '5min') {
  const w = velocity?.[window]
  return {
    window,
    score: interestScore(w),
    buyers: num(w?.buyers),
    sellers: num(w?.sellers),
    traders: num(w?.traders),
    buys: num(w?.buys),
    sells: num(w?.sells),
    trades: num(w?.trades),
    volumeUsd: num(w?.volumeUsd),
    buySellRatio: buySellRatio(w),
    washIndex: washIndex(w),
    acceleration: acceleration(velocity)
  }
}
