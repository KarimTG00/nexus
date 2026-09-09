import { useEffect, useState } from 'react'
import { api } from '../api.js'
import {
  usd, num, pct, signed, age, dateHeure, court,
  CHAINES, STATUTS, VERDICTS, explorateur
} from '../format.js'
import { Badge, Card, Stat, ChainDot, Empty, Spinner, Sparkline } from './ui.jsx'

/** Une ligne de filtre : nom, valeur MESURÉE, seuil, verdict. */
function LigneFiltre({ f }) {
  const etat = f.skipped ? 'skipped' : f.passed ? 'pass' : 'fail'
  const icone = { pass: '✓', fail: '✕', skipped: '⚠' }[etat]
  const couleur = { pass: 'text-up', fail: 'text-down', skipped: 'text-warn' }[etat]

  return (
    <div className="flex items-baseline gap-3 border-b border-line-soft py-1.5 last:border-0">
      <span className={`w-4 shrink-0 text-center text-sm ${couleur}`}>{icone}</span>
      <span className="w-36 shrink-0 truncate font-mono text-[12px] text-ink-dim">{f.name}</span>
      <span className="w-24 shrink-0 font-mono text-[12px] text-ink">
        {f.value === null || f.value === undefined ? '—' : String(f.value)}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-ink-faint">
        {f.threshold !== null && f.threshold !== undefined ? `seuil ${f.threshold}` : ''}
      </span>
      {f.detail && <span className="truncate text-[11px] text-ink-faint">{f.detail}</span>}
    </div>
  )
}

/** Sous-scores : valeur brute, normalisée, méthode et poids appliqué. */
function Score({ s }) {
  const sous = Object.entries(s.subscores ?? {})
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-bold text-ink">{s.score ?? '—'}</span>
        <span className="text-sm text-ink-faint">/ 100</span>
        {s.score_coverage != null && (
          <Badge ton="dim">couverture {Math.round(s.score_coverage * 100)} %</Badge>
        )}
      </div>

      <div className="space-y-1.5">
        {sous.map(([k, v]) => {
          const brut = s.raw_subscores?.[k]
          const methode = s.score_method?.[k]
          const poids = s.weights_used?.[k]
          return (
            <div key={k} className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-[11px] text-ink-dim">{k}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
                {v !== null && <div className="h-full rounded-full bg-accent" style={{ width: `${v}%` }} />}
              </div>
              <span className="w-8 shrink-0 text-right font-mono text-[11px] text-ink">{v ?? '—'}</span>
              <span className="w-28 shrink-0 text-right text-[10px] text-ink-faint">
                {brut !== null && brut !== undefined ? `brut ${Number(brut).toFixed(1)}` : 'absent'}
                {poids ? ` · ${Math.round(poids * 100)} %` : ''}
              </span>
            </div>
          )
        })}
      </div>

      {Object.values(s.score_method ?? {}).includes('linéaire') && (
        <p className="rounded-md border border-warn/25 bg-warn/8 px-2.5 py-1.5 text-[11px] text-warn">
          Normalisation linéaire : moins de 30 décisions en historique, les percentiles
          ne sont pas encore fiables. Ce score n'est pas comparable à ceux calculés plus tard.
        </p>
      )}
    </div>
  )
}

export default function TokenDetail({ id }) {
  const [d, setD] = useState(null)
  const [chargement, setChargement] = useState(true)
  const [erreur, setErreur] = useState(null)

  useEffect(() => {
    if (!id) return
    let annule = false
    setChargement(true); setD(null)
    api.token(id)
      .then(x => { if (!annule) { setD(x); setErreur(null) } })
      .catch(e => { if (!annule) setErreur(e.message) })
      .finally(() => { if (!annule) setChargement(false) })
    return () => { annule = true }
  }, [id])

  if (!id) return <Empty>Sélectionnez un token dans la liste.</Empty>
  if (chargement) return <Spinner />
  if (erreur) return <Empty>Erreur : {erreur}</Empty>
  if (!d) return <Empty>Token introuvable.</Empty>

  const t = d.token
  const st = STATUTS[t.status] ?? { label: t.status, ton: 'faint' }
  const lien = explorateur(t.chain, t.address)
  const v5 = t.velocity?.['5min'] ?? {}
  const interet = v5.buyers != null && v5.sellers != null ? v5.buyers - v5.sellers : null

  // Signaux Mobula enregistrés sans être utilisés — c'est M6 qui dira s'ils prédisent.
  const candidats = Object.entries(t.candidates ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')

  return (
    <div className="space-y-4 p-4">
      {/* --- en-tête ------------------------------------------------------ */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="text-2xl font-bold text-ink">{t.symbol || '—'}</h1>
            <span className="truncate text-sm text-ink-dim">{t.name}</span>
            <Badge ton={st.ton}>{st.label}</Badge>
            {t.tier && <Badge ton="dim">{t.tier}</Badge>}
            {t.muted && <Badge ton="faint">muet</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-ink-faint">
            <ChainDot chain={t.chain} chaines={CHAINES} />
            <span className="font-mono">{court(t.address)}</span>
            {t.launchpad && <span>{t.launchpad}</span>}
            <span>créé il y a {age(t.createdAt)}</span>
            {lien && (
              <a href={lien} target="_blank" rel="noreferrer"
                className="text-accent hover:underline">DexScreener ↗</a>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-ink">{usd(t.market?.mc)}</div>
          <div className="text-[12px] text-ink-faint">market cap</div>
        </div>
      </div>

      {/* --- chiffres clés ------------------------------------------------ */}
      <Card title="État courant">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="Liquidité réelle" value={usd(t.liquidity?.aggregate ?? t.market?.liquidity_usd)}
            hint={t.liquidity?.divergence ? `${t.liquidity.divergence}× l'affichage public` : null} />
          <Stat label="Liquidité affichée" value={usd(t.liquidity?.consensus)}
            hint="ce que voient les autres traders" />
          <Stat label="Score d'intérêt" value={signed(interet)}
            ton={interet > 0 ? 'up' : interet < 0 ? 'down' : undefined}
            hint="acheteurs − vendeurs uniques, 5 min" />
          <Stat label="Traders 5 min" value={num(v5.traders)}
            hint={v5.trades && v5.traders ? `${(v5.trades / v5.traders).toFixed(1)} tx/trader` : null} />
          <Stat label="Holders" value={num(t.holders?.count)} />
          <Stat label="Top 10" value={pct(t.holders?.top10Pct)} />
          <Stat label="Pools" value={num(t.pools?.length)}
            hint={t.isMultichain ? `multichain, ${t.contractsCount} contrats` : null} />
          <Stat label="Sécurité"
            value={t.security?.checked ? 'contrôlée' : 'non contrôlée'}
            ton={t.security?.checked ? 'up' : 'warn'}
            hint={t.security?.checked ? null : t.security?.reason} />
        </div>
      </Card>

      {/* --- évolution ---------------------------------------------------- */}
      {d.metrics.length > 1 && (
        <Card title={`Évolution — ${d.metrics.length} relevés`}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">Market cap</div>
              <Sparkline points={d.metrics.map(m => m.mc)} />
            </div>
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">Score d'intérêt</div>
              <Sparkline points={d.metrics.map(m => m.score)} ton="info" />
            </div>
          </div>
        </Card>
      )}

      {/* --- décisions ---------------------------------------------------- */}
      {d.snapshots.map(s => {
        const out = d.outcomes.find(o => o._id === s._id)
        const verdict = out ? VERDICTS[out.verdict] : null
        return (
          <Card key={s._id}
            title={`Franchissement ${usd(s.threshold)}`}
            right={
              <div className="flex items-center gap-2">
                <Badge ton={s.decision === 'alerted' ? 'up' : 'down'}>
                  {s.decision === 'alerted' ? 'alerté' : 'rejeté'}
                </Badge>
                {verdict && <Badge ton={verdict.ton}>{verdict.label}</Badge>}
                <span className="text-[11px] text-ink-faint">{dateHeure(s.ts)}</span>
              </div>
            }>
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-faint">
                  Filtres — valeur mesurée au moment de la décision
                </div>
                {s.filters?.map(f => <LigneFiltre key={f.name} f={f} />)}
                {s.rejection_reason && (
                  <p className="mt-2 text-[12px] text-down">
                    Rejeté sur <span className="font-mono">{s.rejection_reason}</span>
                  </p>
                )}
              </div>
              <div>
                <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-faint">Score</div>
                <Score s={s} />
              </div>
            </div>

            {out && (
              <div className="mt-4 border-t border-line-soft pt-3">
                <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-faint">
                  Devenu quoi ? — suivi à T+1h, 6h, 24h, 7j
                </div>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Stat label="Multiple max" value={out.multiple_max ? out.multiple_max + '×' : '—'}
                    ton={out.multiple_max >= 5 ? 'up' : undefined} />
                  <Stat label="MC max" value={usd(out.mc_max)} />
                  <Stat label="Drawdown" value={pct(out.drawdown_from_peak_pct)} />
                  <Stat label="Verdict" value={verdict?.label ?? '—'} ton={verdict?.ton} />
                </div>
                {out.rugged && (
                  <p className="mt-2 rounded-md border border-down/25 bg-down/8 px-2.5 py-1.5 text-[11px] text-down">
                    Rug pull ({out.rug_type}) — {out.rug_reason}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-ink-faint">
                  {Object.entries(out.checkpoints ?? {}).map(([k, c]) => (
                    <span key={k} className="font-mono">
                      {k} : {usd(c.mc)} / liq {usd(c.liquidity_usd)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )
      })}

      {/* --- rejet à l'admission ------------------------------------------ */}
      {d.rejet && (
        <Card title="Rejeté à l'admission">
          <div className="flex flex-wrap items-baseline gap-6">
            <Stat label="Motif" value={d.rejet.reason} ton="down" />
            <Stat label="Valeur mesurée" value={String(d.rejet.value ?? '—')} />
            <Stat label="Seuil" value={String(d.rejet.threshold ?? '—')} />
            <Stat label="Seconde chance"
              value={d.rejet.next_retry_at ? 'oui' : 'non'}
              hint={d.rejet.next_retry_at ? dateHeure(d.rejet.next_retry_at) : null} />
          </div>
        </Card>
      )}

      {/* --- filtres d'admission ------------------------------------------ */}
      {t.admissionFilters?.length > 0 && (
        <Card title="Filtres d'admission">
          {t.admissionFilters.map(f => <LigneFiltre key={f.name} f={f} />)}
        </Card>
      )}

      {/* --- métriques candidates ----------------------------------------- */}
      {candidats.length > 0 && (
        <Card title={`Métriques candidates — ${candidats.length} enregistrées, aucune utilisée`}>
          <p className="mb-3 text-[11px] text-ink-faint">
            Ces signaux sont collectés sans servir de filtre. C'est M6 qui mesurera,
            sur les verdicts accumulés, lesquels prédisent réellement quelque chose.
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
            {candidats.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2 border-b border-line-soft py-1">
                <span className="truncate font-mono text-[11px] text-ink-faint">{k}</span>
                <span className="shrink-0 font-mono text-[12px] text-ink">
                  {typeof v === 'number' ? v.toFixed(2) : String(v)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* --- pools -------------------------------------------------------- */}
      {t.pools?.length > 0 && (
        <Card title={`Pools — ${t.pools.length}`}>
          <div className="space-y-1">
            {t.pools.slice(0, 12).map(p => (
              <div key={p.address}
                className="flex items-baseline justify-between gap-3 border-b border-line-soft py-1.5 last:border-0">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="font-mono text-[11px] text-ink-faint">{court(p.address)}</span>
                  <span className="truncate text-[12px] text-ink-dim">{p.dex}</span>
                  {p.address === t.primaryPool && <Badge ton="accent">principal</Badge>}
                </span>
                <span className="shrink-0 text-[12px] text-ink">{usd(p.liquidity_usd)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
