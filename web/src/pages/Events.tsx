import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Check, X, Plus, Trash2, Columns3, Table2, SlidersHorizontal } from 'lucide-react'
import { useApp, api, useCan } from '../lib/store'
import { useT, useAgo } from '../lib/i18n'
import { timeShort } from '../lib/format'
import { Panel, SevTag, SevDot, EmptyNote, Modal } from '../components/ui'
import type { DetectionEvent, DetectionModel, DetectionRule, EventCategory, Severity } from '../lib/types'
import { SEVERITY_COLOR } from '../lib/types'

const MODEL_IDS: DetectionModel[] = ['person', 'smoking', 'thermal', 'ogi', 'gauge', 'ppe', 'motion', 'acoustic']
const CATEGORIES: EventCategory[] = ['security', 'fire', 'env', 'equipment', 'robot-fault']

function CatChip({ cat }: { cat: EventCategory }) {
  const t = useT()
  return (
    <span className="mono border border-line px-1 py-px text-[9.5px] uppercase tracking-[0.08em] text-ink-3">
      {t(`cat.${cat}`)}
    </span>
  )
}

/** builtin models carry i18n labels; site-registered custom types carry their own */
function useModelLabel() {
  const t = useT()
  const eventTypes = useApp((s) => s.eventTypes)
  return (m: string) => (MODEL_IDS.includes(m) ? t(`ev.m.${m}`) : (eventTypes.find((x) => x.id === m)?.label ?? m))
}

function Snapshot({ ev, size = 'sm' }: { ev: DetectionEvent; size?: 'sm' | 'lg' }) {
  if (!ev.snapshot) return <div className={`skeleton ${size === 'sm' ? 'h-12 w-20' : 'h-40 w-full'} opacity-30`} />
  return (
    <img
      src={ev.snapshot}
      alt={ev.label}
      className={size === 'sm' ? 'h-12 w-20 border border-line object-cover' : 'w-full border border-line object-contain'}
      loading="lazy"
    />
  )
}

function DetailModal({ ev, onClose, onRule }: { ev: DetectionEvent; onClose: () => void; onRule: (id: string) => void }) {
  const canOp = useCan('operator')
  const setLifecycle = useApp((s) => s.setLifecycle)
  const rules = useApp((s) => s.rules)
  const rule = rules.find((r) => r.id === ev.ruleId)
  const t = useT()
  const ago = useAgo()
  const readingEv = ev.evidence.find((e) => e.kind === 'reading')?.reading
  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="mono text-[12px] text-ink-3">{ev.id}</span>
          <SevTag sev={ev.severity} />
          <CatChip cat={ev.category} />
        </div>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="close">
          <X size={16} />
        </button>
      </div>
      <div className="space-y-3 p-4">
        <div>
          <div className="text-[15px] font-medium text-ink">{ev.label}</div>
          <div className="mt-1 text-[13.5px] text-ink-2">{ev.detail}</div>
        </div>
        <Snapshot ev={ev} size="lg" />
        {readingEv && (
          <div className="flex items-center gap-2 border border-line bg-surface-2/60 px-3 py-2">
            <span className="microlabel">{t('ev.evReading')}</span>
            <span className="mono text-[13px] text-ink">
              {readingEv.metric} = {readingEv.value}
              {readingEv.unit}
            </span>
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
          {([
            [t('c.time'), `${timeShort(ev.ts)} · ${ago(ev.ts)}`],
            [t('c.zone'), ev.zone],
            [t('c.source'), ev.sourceName],
            [
              t('ev.rule'),
              rule ? (
                <button key="r" onClick={() => onRule(rule.id)} className="mono text-[12.5px] text-ink underline decoration-ink-3 underline-offset-2 hover:text-accent">
                  {rule.name}
                </button>
              ) : (
                ev.ruleId
              ),
            ],
            [t('c.confidence'), `${Math.round(ev.confidence * 100)}%`],
            [t('c.status'), t(`lc.${ev.lifecycle}`)],
            ...(ev.runId ? [[t('ev.run'), ev.runId] as [string, React.ReactNode]] : []),
          ] as [string, React.ReactNode][]
          ).map(([k, v]) => (
            <div key={k}>
              <div className="microlabel mb-0.5">{k}</div>
              <div className="mono text-[12.5px] text-ink-2">{v}</div>
            </div>
          ))}
        </div>
        {canOp && (ev.lifecycle === 'new' || ev.lifecycle === 'acked') && (
          <div className="flex gap-2">
            {ev.lifecycle === 'new' && (
              <button
                onClick={() => setLifecycle(ev.id, 'acked')}
                className="mono flex flex-1 items-center justify-center gap-2 border border-ink/30 bg-ink/10 px-3 py-2 text-[12px] tracking-[0.1em] text-ink transition-colors hover:bg-ink/15"
              >
                <Check size={13} /> {t('c.acknowledge')}
              </button>
            )}
            <button
              onClick={() => {
                setLifecycle(ev.id, 'resolved')
                onClose()
              }}
              className="mono flex flex-1 items-center justify-center gap-2 border border-accent/40 bg-accent/10 px-3 py-2 text-[12px] tracking-[0.1em] text-accent transition-colors hover:bg-accent/20"
            >
              {t('c.resolve')}
            </button>
            <button
              onClick={() => {
                setLifecycle(ev.id, 'dismissed')
                onClose()
              }}
              title={t('ev.dismissHint')}
              className="mono flex flex-1 items-center justify-center gap-2 border border-line-2 px-3 py-2 text-[12px] tracking-[0.1em] text-ink-3 transition-colors hover:border-ink-3 hover:text-ink"
            >
              {t('c.dismiss')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ---------- board ----------

function BoardCard({ e, onOpen }: { e: DetectionEvent; onOpen: () => void }) {
  const canOp = useCan('operator')
  const ack = useApp((s) => s.ack)
  const clock = useApp((s) => s.clock)
  const t = useT()
  const ago = useAgo()
  return (
    <div
      onClick={onOpen}
      className={`group cursor-pointer border border-line bg-surface-2/60 p-2.5 transition-colors hover:border-line-2 ${
        Date.now() - e.ts < 8000 ? 'flash-new' : ''
      } ${e.acked ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center gap-2">
        <SevDot sev={e.severity} pulse={!e.acked && e.severity === 'critical'} />
        <span className="mono text-[11px] text-ink-3">{ago(e.ts, clock)}</span>
        <span className="mono ml-auto text-[10px] text-ink-3">{Math.round(e.confidence * 100)}%</span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-[13.5px] leading-snug text-ink">{e.label}</div>
      <div className="microlabel mt-1 truncate">{e.zone}</div>
      {e.snapshot && <img src={e.snapshot} alt="" loading="lazy" className="mt-2 h-20 w-full border border-line object-cover" />}
      {!e.acked && canOp && (
        <button
          onClick={(ev) => {
            ev.stopPropagation()
            ack(e.id)
          }}
          className="mono mt-2 w-full border border-line-2 px-2 py-1 text-[10.5px] tracking-[0.1em] text-ink-3 opacity-0 transition-all hover:border-ink-3 hover:text-ink group-hover:opacity-100 max-md:opacity-100"
        >
          {t('c.ack')}
        </button>
      )}
    </div>
  )
}

function Board({ events, onOpen }: { events: DetectionEvent[]; onOpen: (e: DetectionEvent) => void }) {
  const t = useT()
  const cols: { key: string; label: string; sevs: Severity[]; tone: string }[] = [
    { key: 'crit', label: t('ev.col.critical'), sevs: ['critical'], tone: SEVERITY_COLOR.critical },
    { key: 'high', label: t('ev.col.high'), sevs: ['high'], tone: SEVERITY_COLOR.high },
    { key: 'routine', label: t('ev.col.routine'), sevs: ['info', 'low'], tone: 'var(--color-ink-3)' },
  ]
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {cols.map((c) => {
        const list = events.filter((e) => c.sevs.includes(e.severity))
        const open = list.filter((e) => !e.acked).length
        return (
          <div key={c.key} className="flex min-h-[200px] flex-col border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
              <span className="h-2 w-2" style={{ background: c.tone }} />
              <span className="microlabel" style={{ color: 'var(--color-ink-2)' }}>
                {c.label}
              </span>
              <span className="mono ml-auto text-[11px] text-ink-3">
                {open} {t('c.open')} · {list.length}
              </span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-2.5 md:max-h-[calc(100vh-260px)]">
              {list.length === 0 && (
                <div className="flex h-24 items-center justify-center">
                  <span className="microlabel">{t('ev.clear')}</span>
                </div>
              )}
              {list.map((e) => (
                <BoardCard key={e.id} e={e} onOpen={() => onOpen(e)} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------- rules ----------

function RuleRow({ r, hi, onViewEvents }: { r: DetectionRule; hi?: boolean; onViewEvents: (id: string) => void }) {
  const canAdmin = useCan('admin')
  const modelLabel = useModelLabel()
  const t = useT()
  const ago = useAgo()
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/70 px-3.5 py-3"
      style={hi ? { boxShadow: 'inset 2px 0 0 var(--color-accent)', background: 'var(--color-surface-2)' } : undefined}
    >
      <button
        onClick={canAdmin ? () => api.patchRule(r.id, { enabled: !r.enabled }) : undefined}
        className="relative h-4 w-8 shrink-0 border border-line-2 transition-colors"
        style={{ background: r.enabled ? 'var(--color-surface-3)' : 'transparent' }}
        title={r.enabled ? 'disable' : 'enable'}
      >
        <span
          className="absolute top-0.5 h-2.5 w-2.5 transition-all"
          style={{ left: r.enabled ? 18 : 3, background: r.enabled ? 'var(--color-ink)' : 'var(--color-ink-3)' }}
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`truncate text-[13.5px] ${r.enabled ? 'text-ink' : 'text-ink-3'}`}>{r.name}</span>
          {!r.builtin && <span className="mono border border-line px-1 text-[9.5px] tracking-[0.1em] text-ink-3">{t('ev.custom')}</span>}
        </div>
        <div className="microlabel mt-0.5 truncate">
          {modelLabel(r.model)} · {r.sourceName}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="microlabel">conf ≥</span>
        <input
          type="range"
          min={0.3}
          max={0.95}
          step={0.05}
          defaultValue={r.threshold}
          disabled={!canAdmin}
          onChange={(e) => api.patchRule(r.id, { threshold: Number(e.target.value) })}
          className="h-[3px] w-20 cursor-pointer appearance-none bg-line-2 accent-ink-2"
        />
        <span className="mono w-8 text-[11.5px] text-ink-2">{Math.round(r.threshold * 100)}%</span>
      </div>
      <SevTag sev={r.severity} />
      <button
        onClick={() => onViewEvents(r.id)}
        title={t('ev.table')}
        className="mono w-32 text-right text-[11px] text-ink-3 transition-colors hover:text-accent"
      >
        {r.firedCount}× {t('ev.fired')}
        <span className="block text-[10px] opacity-80">{r.lastFiredAt ? ago(r.lastFiredAt) : '—'}</span>
      </button>
      {!r.builtin && canAdmin && (
        <button onClick={() => api.deleteRule(r.id)} className="text-ink-3 transition-colors hover:text-crit" title="delete">
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

function NewRuleModal({ onClose }: { onClose: () => void }) {
  const customTypes = useApp((s) => s.eventTypes.filter((x) => !x.builtin))
  const robots = useApp((s) => s.robots)
  const cameras = useApp((s) => s.cameras)
  const zonesList = useApp((s) => s.zones)
  const t = useT()
  const [name, setName] = useState('')
  const [model, setModel] = useState<DetectionModel>('person')
  const [source, setSource] = useState('')
  const [zone, setZone] = useState('')
  const [threshold, setThreshold] = useState(0.7)
  const [severity, setSeverity] = useState<Severity>('high')

  const sources = useMemo(() => {
    const out: { id: string; label: string; robotId?: string }[] = []
    for (const r of robots)
      for (const p of r.payloads)
        if (p.stream || p.file) out.push({ id: p.stream ?? `${r.id}:${p.id}`, label: `${r.callsign} · ${p.name}`, robotId: r.id })
    for (const c of cameras) out.push({ id: c.stream, label: c.name })
    return out
  }, [robots, cameras])

  const submit = async () => {
    if (!name.trim() || !source) return
    const src = sources.find((s) => s.id === source)
    await api.createRule({
      name: name.trim(),
      model,
      source,
      sourceName: src?.label,
      robotId: src?.robotId,
      zone: zone || undefined,
      threshold,
      severity,
    })
    onClose()
  }

  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="microlabel">{t('ev.defineRule')}</span>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="close">
          <X size={16} />
        </button>
      </div>
      <div className="space-y-3.5 p-4">
        <div>
          <div className="microlabel mb-1.5">{t('ev.ruleName')}</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('ev.ruleNamePh')}
            className="mono w-full border border-line-2 bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-ink-3"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="microlabel mb-1.5">{t('ev.model')}</div>
            <select value={model} onChange={(e) => setModel(e.target.value as DetectionModel)} className="mono w-full border border-line-2 bg-surface-2 px-2 py-2 text-[12px] text-ink outline-none">
              {MODEL_IDS.map((m) => (
                <option key={m} value={m}>
                  {t(`ev.m.${m}`)}
                </option>
              ))}
              {customTypes.map((et) => (
                <option key={et.id} value={et.id}>
                  {et.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="microlabel mb-1.5">{t('ev.videoSource')}</div>
            <select value={source} onChange={(e) => setSource(e.target.value)} className="mono w-full border border-line-2 bg-surface-2 px-2 py-2 text-[12px] text-ink outline-none">
              <option value="">{t('ev.select')}</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <div className="microlabel mb-1.5">{t('ev.zoneLabel')}</div>
          <select value={zone} onChange={(e) => setZone(e.target.value)} className="mono w-full border border-line-2 bg-surface-2 px-2 py-2 text-[12px] text-ink outline-none">
            <option value="">{t('ev.siteWide')}</option>
            {zonesList.map((z) => (
              <option key={z.id} value={z.name}>
                {z.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 items-end gap-3">
          <div>
            <div className="microlabel mb-1.5">
              {t('ev.minConf')} · {Math.round(threshold * 100)}%
            </div>
            <input type="range" min={0.3} max={0.95} step={0.05} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="h-[3px] w-full cursor-pointer appearance-none bg-line-2 accent-ink-2" />
          </div>
          <div>
            <div className="microlabel mb-1.5">{t('ev.severity')}</div>
            <div className="flex overflow-hidden border border-line">
              {(['critical', 'high', 'info', 'low'] as Severity[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setSeverity(s)}
                  className={`mono flex-1 px-1 py-1.5 text-[10px] uppercase tracking-[0.06em] transition-colors ${severity === s ? 'bg-surface-3' : 'hover:bg-surface-2'}`}
                  style={{ color: severity === s ? SEVERITY_COLOR[s] : 'var(--color-ink-3)' }}
                >
                  {t(`sev.${s}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <button
          disabled={!name.trim() || !source}
          onClick={submit}
          className="mono w-full border border-ink/30 bg-ink/10 px-3 py-2.5 text-[12px] tracking-[0.12em] text-ink transition-colors hover:bg-ink/15 disabled:opacity-30"
        >
          {t('ev.activate')}
        </button>
      </div>
    </Modal>
  )
}

// ---------- page ----------

type View = 'board' | 'table' | 'rules'

export function Events() {
  const canOp = useCan('operator')
  const canAdmin = useCan('admin')
  const events = useApp((s) => s.events)
  const rules = useApp((s) => s.rules)
  const ack = useApp((s) => s.ack)
  const clock = useApp((s) => s.clock)
  const t = useT()
  const ago = useAgo()
  const [view, setView] = useState<View>(() => {
    const v = new URLSearchParams(window.location.search).get('view')
    return v === 'rules' || v === 'table' ? v : 'board'
  })
  const [sel, setSel] = useState<DetectionEvent | null>(null)
  const [params, setParams] = useSearchParams()
  // deep link: /events?ev=EV-0042 lands with that event's detail already open
  // (toasts, the overview feed and map pins all arrive here)
  useEffect(() => {
    const id = params.get('ev')
    if (!id) return
    const hit = events.find((e) => e.id === id)
    if (hit) setSel(hit)
  }, [params, events])
  const closeDetail = () => {
    setSel(null)
    if (params.get('ev')) {
      params.delete('ev')
      setParams(params, { replace: true })
    }
  }
  const [newRule, setNewRule] = useState(false)
  const [ruleFilter, setRuleFilter] = useState<string | null>(null)
  const [hiRule, setHiRule] = useState<string | null>(null)
  const [catFilter, setCatFilter] = useState<EventCategory | null>(null)

  const unacked = events.filter((e) => e.lifecycle === 'new').length
  let shown = ruleFilter ? events.filter((e) => e.ruleId === ruleFilter) : events
  if (catFilter) shown = shown.filter((e) => e.category === catFilter)
  // the operator board hides dismissed noise; the table keeps everything for audit
  const boardShown = shown.filter((e) => e.lifecycle !== 'dismissed')
  const filterRule = ruleFilter ? rules.find((r) => r.id === ruleFilter) : null

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="mono text-[14px] text-ink-2">
            {events.length} {t('c.events')} · <span style={{ color: unacked ? 'var(--color-warn)' : 'var(--color-ok)' }}>{unacked} {t('c.open')}</span>
            {' · '}{rules.filter((r) => r.enabled).length}/{rules.length} {t('ev.rulesArmed')}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {CATEGORIES.map((c) => {
              const n = events.filter((e) => e.category === c && e.lifecycle === 'new').length
              const on = catFilter === c
              return (
                <button
                  key={c}
                  onClick={() => setCatFilter(on ? null : c)}
                  className={`mono border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] transition-colors ${
                    on ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-ink-3 hover:border-line-2 hover:text-ink-2'
                  }`}
                >
                  {t(`cat.${c}`)}
                  {n > 0 && <span className="ml-1 opacity-80">{n}</span>}
                </button>
              )
            })}
            {filterRule && (
              <button
                onClick={() => setRuleFilter(null)}
                className="mono flex items-center gap-1.5 border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10.5px] tracking-[0.06em] text-accent transition-colors hover:bg-accent/20"
              >
                {filterRule.name} <X size={11} />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {view === 'rules' && canAdmin && (
            <button
              onClick={() => setNewRule(true)}
              className="mono flex items-center gap-1.5 border border-ink/30 bg-ink/10 px-2.5 py-1.5 text-[11.5px] tracking-[0.1em] text-ink transition-colors hover:bg-ink/15"
            >
              <Plus size={13} /> {t('ev.newRule')}
            </button>
          )}
          <div className="flex overflow-hidden border border-line">
            {(
              [
                ['board', Columns3, t('ev.board')],
                ['table', Table2, t('ev.table')],
                ['rules', SlidersHorizontal, t('ev.rules')],
              ] as const
            ).map(([v, Icon, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] transition-colors ${view === v ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:text-ink-2'}`}
              >
                <Icon size={13} strokeWidth={1.5} />
                <span className="mono hidden text-[11px] tracking-[0.08em] sm:block">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === 'board' && <Board events={boardShown} onOpen={setSel} />}

      {view === 'table' && (
        <Panel className="rise overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                {[t('c.time'), t('ev.severity'), t('ev.event'), t('ev.zoneSource'), t('ev.conf'), t('ev.frame'), ''].map((h, i) => (
                  <th key={i} className="microlabel px-3.5 py-2.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => setSel(e)}
                  className={`cursor-pointer border-b border-line/60 transition-colors hover:bg-surface-2 ${Date.now() - e.ts < 8000 ? 'flash-new' : ''} ${e.acked ? 'opacity-50' : ''}`}
                >
                  <td className="mono whitespace-nowrap px-3.5 py-2.5 align-top text-[12px] text-ink-3">
                    {timeShort(e.ts)}
                    <div className="text-[11px] opacity-70">{ago(e.ts, clock)}</div>
                  </td>
                  <td className="px-3.5 py-2.5 align-top">
                    <SevTag sev={e.severity} />
                  </td>
                  <td className="max-w-[320px] px-3.5 py-2.5 align-top">
                    <div className="truncate text-[13.5px] text-ink">{e.label}</div>
                    <div className="truncate text-[12px] text-ink-3">{e.detail}</div>
                  </td>
                  <td className="px-3.5 py-2.5 align-top">
                    <div className="text-[12.5px] text-ink-2">{e.zone}</div>
                    <div className="microlabel mt-0.5">{e.sourceName}</div>
                  </td>
                  <td className="mono px-3.5 py-2.5 align-top text-[12px] text-ink-2">{Math.round(e.confidence * 100)}%</td>
                  <td className="px-3.5 py-2.5 align-top">
                    <Snapshot ev={e} />
                  </td>
                  <td className="px-3.5 py-2.5 align-top">
                    {!e.acked && canOp && (
                      <button
                        onClick={(ev) => {
                          ev.stopPropagation()
                          ack(e.id)
                        }}
                        className="mono border border-line-2 px-2 py-1 text-[11px] tracking-[0.08em] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
                      >
                        {t('c.ack')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <EmptyNote>{t('ev.noEvents')}</EmptyNote>}
        </Panel>
      )}

      {view === 'rules' && (
        <Panel className="rise">
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <span className="microlabel">{t('ev.rulesTitle')}</span>
            <span className="mono hidden text-[11px] text-ink-3 sm:block">{t('ev.rulesHint')}</span>
          </div>
          {rules.map((r) => (
            <RuleRow
              key={r.id}
              r={r}
              hi={hiRule === r.id}
              onViewEvents={(id) => {
                setRuleFilter(id)
                setView('table')
              }}
            />
          ))}
        </Panel>
      )}

      {sel && (
        <DetailModal
          ev={sel}
          onClose={closeDetail}
          onRule={(id) => {
            closeDetail()
            setHiRule(id)
            setView('rules')
          }}
        />
      )}
      {newRule && <NewRuleModal onClose={() => setNewRule(false)} />}
    </div>
  )
}
