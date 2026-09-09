/** Briques d'interface partagées. */

const TONS = {
  up: 'text-up bg-up/10 border-up/25',
  down: 'text-down bg-down/10 border-down/25',
  warn: 'text-warn bg-warn/10 border-warn/25',
  info: 'text-info bg-info/10 border-info/25',
  accent: 'text-accent bg-accent/12 border-accent/30',
  dim: 'text-ink-dim bg-ink-dim/8 border-ink-dim/20',
  faint: 'text-ink-faint bg-ink-faint/8 border-ink-faint/15'
}

export function Badge({ children, ton = 'dim', className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5
      text-[11px] font-medium leading-none whitespace-nowrap ${TONS[ton] ?? TONS.dim} ${className}`}>
      {children}
    </span>
  )
}

export function Card({ title, right, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-line bg-surface ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-wide text-ink-dim uppercase">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

/** Paire libellé/valeur — l'unité de lecture du panneau de détail. */
export function Stat({ label, value, hint, ton }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className={`mt-0.5 truncate text-[15px] font-semibold ${ton ? TONS[ton]?.split(' ')[0] : 'text-ink'}`}>
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-ink-faint">{hint}</div>}
    </div>
  )
}

export function ChainDot({ chain, chaines }) {
  const c = chaines[chain]
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="size-1.5 rounded-full" style={{ background: c?.teinte ?? '#6b7280' }} />
      <span className="text-ink-dim">{c?.nom ?? chain}</span>
    </span>
  )
}

export function Empty({ children }) {
  return <div className="py-10 text-center text-sm text-ink-faint">{children}</div>
}

export function Spinner({ label = 'Chargement' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-faint">
      <span className="size-3 animate-spin rounded-full border-2 border-ink-faint/30 border-t-accent" />
      {label}…
    </div>
  )
}

/**
 * Courbe compacte en SVG. Pas de bibliothèque de graphiques : une polyligne
 * suffit pour une évolution, et ça évite 200 Ko de dépendance.
 */
export function Sparkline({ points, height = 44, ton = 'accent' }) {
  const vals = (points ?? []).filter(v => typeof v === 'number' && Number.isFinite(v))
  if (vals.length < 2) return <div className="text-[11px] text-ink-faint">série trop courte</div>

  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const w = 100
  const d = vals.map((v, i) =>
    `${(i / (vals.length - 1)) * w},${height - ((v - min) / span) * (height - 4) - 2}`).join(' ')

  const couleur = { accent: '#7c6df2', up: '#4ade80', down: '#f87171', info: '#60a5fa' }[ton] ?? '#7c6df2'
  const monte = vals.at(-1) >= vals[0]

  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="h-11 w-full">
      <polyline points={d} fill="none" stroke={monte ? couleur : '#f87171'} strokeWidth="1.5"
        vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
