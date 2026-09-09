import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { num, pct, usd, VERDICTS, CHAINES } from '../format.js'
import { Badge, Card, Stat, Empty, Spinner } from './ui.jsx'

/**
 * Encart d'honnêteté statistique.
 *
 * Sans lui, un tableau de trois lignes ressemble à un résultat. Un verdict
 * demande sept jours par token : tant que l'échantillon est mince, il faut
 * le dire à l'écran plutôt que de laisser lire du bruit comme un signal.
 */
function Insuffisant({ n, requis = 30, quoi = 'décisions avec verdict' }) {
  if (n >= requis) return null
  return (
    <p className="rounded-md border border-warn/25 bg-warn/8 px-3 py-2 text-[12px] text-warn">
      <strong>{n}</strong> {quoi} — il en faut au moins {requis} pour conclure.
      Un verdict demande 7 jours de suivi par token : ces chiffres sont affichés
      pour vérifier que le calcul tourne, pas pour décider.
    </p>
  )
}

/** Barre horizontale proportionnelle, pour comparer sans graphique. */
function Barre({ valeur, max, ton = 'accent', suffixe = '' }) {
  const couleur = { accent: 'bg-accent', up: 'bg-up', down: 'bg-down', warn: 'bg-warn', info: 'bg-info' }[ton]
  const largeur = max > 0 ? Math.max(2, (valeur / max) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-raised">
        <div className={`h-full rounded-full ${couleur}`} style={{ width: `${largeur}%` }} />
      </div>
      <span className="w-16 shrink-0 text-right font-mono text-[11px] text-ink-dim">
        {num(valeur)}{suffixe}
      </span>
    </div>
  )
}

const TON_VERDICT = {
  'bon filtre': 'up',
  'ne discrimine pas': 'down',
  'discutable': 'warn',
  'échantillon insuffisant': 'faint',
  'indéterminé': 'faint'
}

/** ① Le tableau central de M5. */
function Efficacite({ perf }) {
  const e = perf?.efficacite
  if (!e) return <Empty>Aucun rapport de calibration.</Empty>

  const ref = e.reference

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ink-dim">
        Pour chaque filtre : parmi les tokens qu'il a <strong>rejetés</strong>, combien ont
        réussi quand même ? Si ce taux approche celui des tokens alertés, le filtre
        ne discrimine rien — il coûte des opportunités sans protéger.
      </p>

      <div className="rounded-lg border border-accent/25 bg-accent/8 px-3 py-2">
        <div className="text-[11px] uppercase tracking-wide text-ink-faint">Référence</div>
        <div className="mt-0.5 text-[13px] text-ink">
          <strong>{num(ref?.alertes)}</strong> tokens alertés, dont{' '}
          <strong className="text-accent">
            {ref?.taux_succes !== null ? pct(ref.taux_succes * 100, 1) : '—'}
          </strong>{' '}
          ont fait ×5 ou plus
        </div>
      </div>

      <Insuffisant n={perf.decisions ?? 0} />

      {e.filtres.length === 0
        ? <Empty>Aucun rejet n'a encore de verdict.</Empty>
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="py-2 pr-3 font-medium">Filtre</th>
                  <th className="py-2 pr-3 text-right font-medium">Rejetés</th>
                  <th className="py-2 pr-3 text-right font-medium">Ont réussi</th>
                  <th className="py-2 pr-3 text-right font-medium">Taux</th>
                  <th className="py-2 pr-3 text-right font-medium">Rugs évités</th>
                  <th className="py-2 font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {e.filtres.map(f => (
                  <tr key={f.filtre} className="border-b border-line-soft">
                    <td className="py-2 pr-3 font-mono text-ink-dim">{f.filtre}</td>
                    <td className="py-2 pr-3 text-right text-ink">{num(f.rejetes)}</td>
                    <td className="py-2 pr-3 text-right text-ink">{num(f.succes_apres_rejet)}</td>
                    <td className={`py-2 pr-3 text-right font-semibold
                      ${ref?.taux_succes && f.taux >= ref.taux_succes * 0.8 ? 'text-down' : 'text-up'}`}>
                      {pct(f.taux * 100, 1)}
                    </td>
                    <td className="py-2 pr-3 text-right text-ink-dim">{num(f.rugs_evites)}</td>
                    <td className="py-2">
                      <Badge ton={TON_VERDICT[f.verdict] ?? 'faint'}>{f.verdict}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

/** ② Balayage de seuil — la courbe alertes × précision. */
function Balayages({ perf }) {
  const b = perf?.balayages ?? {}
  const entrees = Object.entries(b)
  if (!entrees.length) return <Empty>Aucun balayage.</Empty>

  return (
    <div className="space-y-5">
      <p className="text-[12px] text-ink-dim">
        Chaque seuil candidat est rejoué sur l'historique, sans un seul appel réseau.
        Possible uniquement parce que la <strong>valeur mesurée</strong> de chaque filtre
        est stockée, et pas un simple réussi/échoué.
      </p>

      {entrees.map(([nom, sw]) => {
        if (sw.insuffisant) {
          return (
            <div key={nom}>
              <div className="mb-1 font-mono text-[12px] text-ink-dim">{nom}</div>
              <Insuffisant n={sw.echantillon} requis={10} quoi="valeurs mesurées" />
            </div>
          )
        }
        const maxAlertes = Math.max(...sw.courbe.map(c => c.alertes), 1)
        return (
          <div key={nom}>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="font-mono text-[12px] text-ink-dim">{nom}</span>
              <span className="text-[11px] text-ink-faint">
                {sw.echantillon} points · sens « {sw.direction === 'below' ? 'inférieur à' : 'supérieur ou égal à'} »
              </span>
            </div>
            <div className="space-y-1.5">
              {sw.courbe.map(c => (
                <div key={c.seuil} className="flex items-center gap-3">
                  <span className="w-14 shrink-0 text-right font-mono text-[11px] text-ink-faint">
                    {c.seuil}
                  </span>
                  <div className="flex-1"><Barre valeur={c.alertes} max={maxAlertes} /></div>
                  <span className={`w-14 shrink-0 text-right font-mono text-[11px]
                    ${c.taux >= 0.3 ? 'text-up' : c.taux > 0 ? 'text-ink-dim' : 'text-ink-faint'}`}>
                    {c.taux !== null ? pct(c.taux * 100, 0) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** ③ + ④ Redondance et ordre d'exécution. */
function Structure({ perf }) {
  const red = perf?.redondance ?? []
  const ordre = perf?.ordre_execution ?? []

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-faint">Redondance</div>
        <p className="mb-2 text-[12px] text-ink-dim">
          Deux filtres qui rejettent les mêmes tokens font double emploi — on paie
          des appels pour rien.
        </p>
        {red.length === 0
          ? <Empty>Pas assez de rejets.</Empty>
          : red.slice(0, 8).map((p, i) => (
            <div key={i} className="flex items-center justify-between gap-3 border-b border-line-soft py-1.5">
              <span className="truncate font-mono text-[11px] text-ink-dim">
                {p.filtres[0]} ≡ {p.filtres[1]}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-[11px] text-ink">{pct(p.recouvrement * 100, 0)}</span>
                {p.doublon && <Badge ton="down">doublon</Badge>}
              </span>
            </div>
          ))}
      </div>

      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-faint">Ordre d'exécution</div>
        <p className="mb-2 text-[12px] text-ink-dim">
          L'étage 5 s'arrête au premier échec : le plus éliminatoire et le moins cher
          doit passer en premier.
        </p>
        {ordre.map((o, i) => (
          <div key={o.filtre} className="flex items-center justify-between gap-3 border-b border-line-soft py-1.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="w-4 shrink-0 text-[11px] text-ink-faint">{i + 1}.</span>
              <span className="truncate font-mono text-[11px] text-ink-dim">{o.filtre}</span>
              <Badge ton={o.cout === 'paid' ? 'warn' : 'faint'}>{o.cout}</Badge>
            </span>
            <span className="shrink-0 font-mono text-[11px] text-ink">
              rejet {pct(o.taux_rejet * 100, 0)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** M7 — où les meilleures performances du marché nous échappent. */
function AnglesMorts({ bs }) {
  if (!bs) return <Empty>Aucun rapport d'angles morts.</Empty>

  const LIGNES = [
    ['alerte', 'Alerté', 'up', 'capturé et signalé'],
    ['rejete_declenchement', 'Rejeté au déclenchement', 'warn', 'vu et analysé — domaine de M5'],
    ['jamais_declenche', 'Vu, jamais déclenché', 'info', 'MC mal suivi ou tier mal promu — à déboguer'],
    ['rejete_admission', 'Rejeté à l\'admission', 'accent', 'un seuil à desserrer — une ligne de config'],
    ['jamais_decouvert', 'Jamais découvert', 'down', 'chaîne, DEX ou source manquante — intégration']
  ]
  const total = bs.echantillon || 1

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-ink-dim">
        Les meilleures performances du marché, confrontées à notre base. Chaque ligne
        appelle un correctif <strong>différent</strong> — sans cette ventilation, on
        constaterait « on rate des tokens » sans savoir où chercher.
      </p>

      <div className="flex flex-wrap gap-6">
        <Stat label="Échantillon" value={num(bs.echantillon)}
          hint={`âge médian ${bs.age_median_h?.toFixed(1) ?? '—'} h · filtre ${bs.age_max_jours} j`} />
        <Stat label="Taux de capture" value={pct(bs.taux_capture * 100, 0)}
          ton={bs.taux_capture > 0.5 ? 'up' : bs.taux_capture > 0.2 ? 'warn' : 'down'}
          hint="vus et analysés" />
      </div>

      <div className="space-y-2">
        {LIGNES.map(([cle, label, ton, aide]) => {
          const n = bs.ventilation?.[cle] ?? 0
          return (
            <div key={cle}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] text-ink">{label}</span>
                <span className="text-[11px] text-ink-faint">{aide}</span>
              </div>
              <div className="mt-1"><Barre valeur={n} max={total} ton={ton} /></div>
            </div>
          )
        })}
      </div>

      {bs.motifs && Object.keys(bs.motifs).length > 0 && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">
            Motifs — quel seuil desserrer
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(bs.motifs).map(([k, v]) => (
              <Badge key={k} ton="dim">{k} · {v}</Badge>
            ))}
          </div>
        </div>
      )}

      {bs.par_chaine && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">Par chaîne</div>
          <div className="flex flex-wrap gap-4">
            {Object.entries(bs.par_chaine).map(([c, x]) => (
              <span key={c} className="text-[12px]">
                <span className="text-ink-dim">{CHAINES[c]?.nom ?? c}</span>{' '}
                <span className={x.vus / x.total > 0.5 ? 'text-up' : 'text-ink-faint'}>
                  {x.vus}/{x.total}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {bs.jamais_decouverts?.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">
            Jamais découverts — les plus gros
          </div>
          <div className="space-y-1">
            {bs.jamais_decouverts.slice(0, 8).map(t => (
              <div key={t.id} className="flex items-baseline justify-between gap-3 border-b border-line-soft py-1">
                <span className="truncate text-[12px] text-ink-dim">
                  {t.symbol || '—'} <span className="text-ink-faint">{CHAINES[t.chain]?.nom ?? t.chain}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink">{usd(t.mc)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Distribution des verdicts et des scores. */
function Verdicts({ verdicts, scores }) {
  const total = verdicts.reduce((s, v) => s + v.n, 0)
  const maxScore = Math.max(...scores.map(s => s.n), 1)

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-faint">
          Verdicts — {num(total)} décisions suivies
        </div>
        {verdicts.length === 0
          ? <Empty>Aucun verdict.</Empty>
          : verdicts.map((v, i) => {
            const info = VERDICTS[v.verdict] ?? { label: v.verdict, ton: 'faint' }
            return (
              <div key={i} className="flex items-center justify-between gap-3 border-b border-line-soft py-1.5">
                <span className="flex items-center gap-2">
                  <Badge ton={info.ton}>{info.label}</Badge>
                  <span className="text-[11px] text-ink-faint">
                    {v.decision === 'alerted' ? 'alertés' : 'rejetés'}
                  </span>
                </span>
                <span className="flex shrink-0 items-baseline gap-3">
                  <span className="font-mono text-[11px] text-ink-faint">
                    ×{v.multiple_moyen ?? '—'} moy · ×{v.multiple_max ?? '—'} max
                  </span>
                  <span className="w-8 text-right font-mono text-[12px] text-ink">{v.n}</span>
                </span>
              </div>
            )
          })}
        <p className="mt-2 text-[11px] text-ink-faint">
          Les rejetés sont suivis exactement comme les alertés — sans eux, aucun
          groupe de comparaison, donc aucune mesure possible de la qualité des filtres.
        </p>
      </div>

      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-faint">
          Distribution des scores
        </div>
        {scores.map(s => (
          <div key={s._id} className="flex items-center gap-3 py-1">
            <span className="w-16 shrink-0 text-right font-mono text-[11px] text-ink-faint">
              {s._id}–{s._id === 90 ? 100 : s._id + (s._id === 60 ? 10 : 20)}
            </span>
            <div className="flex-1">
              <Barre valeur={s.n} max={maxScore} ton={s.alertes > 0 ? 'up' : 'dim'} />
            </div>
            {s.alertes > 0 && <Badge ton="up">{s.alertes} alertés</Badge>}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Entonnoir jour par jour. */
function Entonnoirs({ funnels }) {
  if (!funnels.length) return <Empty>Aucun entonnoir.</Empty>

  const ETAPES = [
    ['vus', 'Vus'], ['nouveaux', 'Nouveaux'], ['admis', 'Admis'],
    ['promus', 'Promus'], ['franchissements', 'Franchissements'], ['alertes', 'Alertes']
  ]

  return (
    <div className="space-y-4">
      {funnels.slice(0, 3).map(f => {
        const c = f.counts ?? {}
        const max = c.vus || 1
        return (
          <div key={f.period}>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[12px] font-semibold text-ink">{f.period}</span>
              <span className="text-[11px] text-ink-faint">{f.cycles} cycles</span>
            </div>
            <div className="space-y-1">
              {ETAPES.map(([k, label], i) => {
                const n = c[k] ?? 0
                const prec = i > 0 ? (c[ETAPES[i - 1][0]] ?? 0) : null
                return (
                  <div key={k} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 text-[11px] text-ink-dim">{label}</span>
                    <div className="flex-1"><Barre valeur={n} max={max} /></div>
                    <span className="w-12 shrink-0 text-right text-[11px] text-ink-faint">
                      {prec ? pct((n / prec) * 100, 0) : ''}
                    </span>
                  </div>
                )
              })}
            </div>
            {f.rejets_admission && (
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(f.rejets_admission).map(([k, v]) => (
                  <Badge key={k} ton="faint">{k} · {num(v)}</Badge>
                ))}
                {Object.entries(f.rejets_declenchement ?? {}).map(([k, v]) => (
                  <Badge key={k} ton="warn">{k} · {num(v)}</Badge>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function Analytics() {
  const [d, setD] = useState(null)
  const [chargement, setChargement] = useState(true)
  const [erreur, setErreur] = useState(null)

  useEffect(() => {
    api.analytics()
      .then(setD).catch(e => setErreur(e.message)).finally(() => setChargement(false))
  }, [])

  if (chargement) return <Spinner label="Chargement des rapports" />
  if (erreur) return <Empty>Erreur : {erreur}</Empty>

  const perf = d.filterPerf?.[0]
  const bs = d.blindspots?.[0]

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-xl font-bold text-ink">Analyse globale</h1>
        <p className="mt-0.5 text-[12px] text-ink-faint">
          Rapports de la face 2 — calculés en différé par le worker analytique.
          {perf && ` Dernier passage : ${perf.period}, fenêtre ${perf.fenetre_jours} jours.`}
        </p>
      </div>

      <Card title="Efficacité des filtres">
        <Efficacite perf={perf} />
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Balayage de seuil"><Balayages perf={perf} /></Card>
        <Card title="Angles morts"><AnglesMorts bs={bs} /></Card>
      </div>

      <Card title="Verdicts et scores">
        <Verdicts verdicts={d.verdicts ?? []} scores={d.scores ?? []} />
      </Card>

      <Card title="Structure des filtres"><Structure perf={perf} /></Card>

      <Card title="Entonnoir"><Entonnoirs funnels={d.funnels ?? []} /></Card>
    </div>
  )
}
