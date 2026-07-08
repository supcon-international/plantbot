import { useMemo, useState } from 'react'
import { Check, X, Plus, Trash2, Columns3, Table2, SlidersHorizontal } from 'lucide-react'
import { useApp, api } from '../lib/store'
import { ago, timeShort } from '../lib/format'
import { Panel, SevTag, SevDot, EmptyNote, Modal } from '../components/ui'
import type { DetectionEvent, DetectionModel, DetectionRule, Severity } from '../lib/types'
import { SEVERITY_COLOR } from '../lib/types'

const MODELS: { id: DetectionModel; label: string }[] = [
  { id: 'person', label: 'Person / intrusion' },
  { id: 'smoking', label: 'Smoking behavior' },
  { id: 'thermal', label: 'Thermal anomaly' },
  { id: 'ogi', label: 'OGI emission' },
  { id: 'gauge', label: 'Gauge OCR' },
  { id: 'ppe', label: 'PPE compliance' },
  { id: 'motion', label: 'Motion' },
  { id: 'acoustic', label: 'Acoustic signature' },
]

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

function DetailModal({ ev, onClose }: { ev: DetectionEvent; onClose: () => void }) {
  const ack = useApp((s) => s.ack)
  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="mono text-[11px] text-ink-3">{ev.id}</span>
          <SevTag sev={ev.severity} />
        </div>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="close">
          <X size={16} />
        </button>
      </div>
      <div className="space-y-3 p-4">
        <div>
          <div className="text-[15px] font-medium text-ink">{ev.label}</div>
          <div className="mt-1 text-[12.5px] text-ink-2">{ev.detail}</div>
        </div>
        <Snapshot ev={ev} size="lg" />
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
          {[
            ['Time', `${timeShort(ev.ts)} · ${ago(ev.ts)}`],
            ['Zone', ev.zone],
            ['Source', ev.sourceName],
            ['Rule', ev.ruleId],
            ['Confidence', `${Math.round(ev.confidence * 100)}%`],
            ['Status', ev.acked ? 'Acknowledged' : 'Open'],
          ].map(([k, v]) => (
            <div key={k}>
              <div className="microlabel mb-0.5">{k}</div>
              <div className="mono text-[11.5px] text-ink-2">{v}</div>
            </div>
          ))}
        </div>
        {!ev.acked && (
          <button
            onClick={() => {
              ack(ev.id)
              onClose()
            }}
            className="mono flex w-full items-center justify-center gap-2 border border-ink/30 bg-ink/10 px-3 py-2 text-[11px] tracking-[0.1em] text-ink transition-colors hover:bg-ink/15"
          >
            <Check size={13} /> ACKNOWLEDGE
          </button>
        )}
      </div>
    </Modal>
  )
}

// ---------- board ----------

function BoardCard({ e, onOpen }: { e: DetectionEvent; onOpen: () => void }) {
  const ack = useApp((s) => s.ack)
  const clock = useApp((s) => s.clock)
  return (
    <div
      onClick={onOpen}
      className={`group cursor-pointer border border-line bg-surface-2/60 p-2.5 transition-colors hover:border-line-2 ${
        Date.now() - e.ts < 8000 ? 'flash-new' : ''
      } ${e.acked ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center gap-2">
        <SevDot sev={e.severity} pulse={!e.acked && e.severity === 'critical'} />
        <span className="mono text-[10px] text-ink-3">{ago(e.ts, clock)}</span>
        <span className="mono ml-auto text-[9px] text-ink-3">{Math.round(e.confidence * 100)}%</span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-ink">{e.label}</div>
      <div className="microlabel mt-1 truncate">{e.zone}</div>
      {e.snapshot && <img src={e.snapshot} alt="" loading="lazy" className="mt-2 h-20 w-full border border-line object-cover" />}
      {!e.acked && (
        <button
          onClick={(ev) => {
            ev.stopPropagation()
            ack(e.id)
          }}
          className="mono mt-2 w-full border border-line-2 px-2 py-1 text-[9.5px] tracking-[0.1em] text-ink-3 opacity-0 transition-all hover:border-ink-3 hover:text-ink group-hover:opacity-100 max-md:opacity-100"
        >
          ACK
        </button>
      )}
    </div>
  )
}

function Board({ events, onOpen }: { events: DetectionEvent[]; onOpen: (e: DetectionEvent) => void }) {
  const cols: { key: string; label: string; sevs: Severity[]; tone: string }[] = [
    { key: 'crit', label: 'Critical', sevs: ['critical'], tone: SEVERITY_COLOR.critical },
    { key: 'high', label: 'High', sevs: ['high'], tone: SEVERITY_COLOR.high },
    { key: 'routine', label: 'Routine', sevs: ['info', 'low'], tone: 'var(--color-ink-3)' },
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
              <span className="mono ml-auto text-[10px] text-ink-3">
                {open} open · {list.length}
              </span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-2.5 md:max-h-[calc(100vh-260px)]">
              {list.length === 0 && (
                <div className="flex h-24 items-center justify-center">
                  <span className="microlabel">clear</span>
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

function RuleRow({ r }: { r: DetectionRule }) {
  const model = MODELS.find((m) => m.id === r.model)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/70 px-3.5 py-3">
      <button
        onClick={() => api.patchRule(r.id, { enabled: !r.enabled })}
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
          <span className={`truncate text-[12.5px] ${r.enabled ? 'text-ink' : 'text-ink-3'}`}>{r.name}</span>
          {!r.builtin && <span className="mono border border-line px-1 text-[8.5px] tracking-[0.1em] text-ink-3">CUSTOM</span>}
        </div>
        <div className="microlabel mt-0.5 truncate">
          {model?.label ?? r.model} · {r.sourceName}
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
          onChange={(e) => api.patchRule(r.id, { threshold: Number(e.target.value) })}
          className="h-[3px] w-20 cursor-pointer appearance-none bg-line-2 accent-white"
        />
        <span className="mono w-8 text-[10.5px] text-ink-2">{Math.round(r.threshold * 100)}%</span>
      </div>
      <SevTag sev={r.severity} />
      <span className="mono w-14 text-right text-[10px] text-ink-3">{r.firedCount}× fired</span>
      {!r.builtin && (
        <button onClick={() => api.deleteRule(r.id)} className="text-ink-3 transition-colors hover:text-crit" title="delete">
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

function NewRuleModal({ onClose }: { onClose: () => void }) {
  const robots = useApp((s) => s.robots)
  const cameras = useApp((s) => s.cameras)
  const [name, setName] = useState('')
  const [model, setModel] = useState<DetectionModel>('person')
  const [source, setSource] = useState('')
  const [zone, setZone] = useState('')
  const [threshold, setThreshold] = useState(0.7)
  const [severity, setSeverity] = useState<Severity>('high')

  const sources = useMemo(() => {
    const out: { id: string; label: string }[] = []
    for (const r of robots)
      for (const p of r.payloads) if (p.stream) out.push({ id: p.stream, label: `${r.callsign} · ${p.name}` })
    for (const c of cameras) out.push({ id: c.stream, label: c.name })
    return out
  }, [robots, cameras])

  const submit = async () => {
    if (!name.trim() || !source) return
    const sourceName = sources.find((s) => s.id === source)?.label
    await api.createRule({ name: name.trim(), model, source, sourceName, zone: zone || undefined, threshold, severity })
    onClose()
  }

  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="microlabel">Define detection rule</span>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="close">
          <X size={16} />
        </button>
      </div>
      <div className="space-y-3.5 p-4">
        <div>
          <div className="microlabel mb-1.5">Rule name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Forklift in walkway"
            className="mono w-full border border-line-2 bg-surface-2 px-2.5 py-2 text-[12px] text-ink outline-none focus:border-ink-3"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="microlabel mb-1.5">Detection model</div>
            <select value={model} onChange={(e) => setModel(e.target.value as DetectionModel)} className="mono w-full border border-line-2 bg-surface-2 px-2 py-2 text-[11px] text-ink outline-none">
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="microlabel mb-1.5">Video source</div>
            <select value={source} onChange={(e) => setSource(e.target.value)} className="mono w-full border border-line-2 bg-surface-2 px-2 py-2 text-[11px] text-ink outline-none">
              <option value="">select…</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <div className="microlabel mb-1.5">Zone label (optional)</div>
          <input
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            placeholder="e.g. Loading dock D-1"
            className="mono w-full border border-line-2 bg-surface-2 px-2.5 py-2 text-[12px] text-ink outline-none focus:border-ink-3"
          />
        </div>
        <div className="grid grid-cols-2 items-end gap-3">
          <div>
            <div className="microlabel mb-1.5">Min confidence · {Math.round(threshold * 100)}%</div>
            <input type="range" min={0.3} max={0.95} step={0.05} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="h-[3px] w-full cursor-pointer appearance-none bg-line-2 accent-white" />
          </div>
          <div>
            <div className="microlabel mb-1.5">Severity</div>
            <div className="flex overflow-hidden border border-line">
              {(['critical', 'high', 'info', 'low'] as Severity[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setSeverity(s)}
                  className={`mono flex-1 px-1 py-1.5 text-[9px] uppercase tracking-[0.06em] transition-colors ${severity === s ? 'bg-surface-3' : 'hover:bg-surface-2'}`}
                  style={{ color: severity === s ? SEVERITY_COLOR[s] : 'var(--color-ink-3)' }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
        <button
          disabled={!name.trim() || !source}
          onClick={submit}
          className="mono w-full border border-ink/30 bg-ink/10 px-3 py-2.5 text-[11px] tracking-[0.12em] text-ink transition-colors hover:bg-ink/15 disabled:opacity-30"
        >
          ACTIVATE RULE
        </button>
      </div>
    </Modal>
  )
}

// ---------- page ----------

type View = 'board' | 'table' | 'rules'

export function Events() {
  const events = useApp((s) => s.events)
  const rules = useApp((s) => s.rules)
  const ack = useApp((s) => s.ack)
  const clock = useApp((s) => s.clock)
  const [view, setView] = useState<View>('board')
  const [sel, setSel] = useState<DetectionEvent | null>(null)
  const [newRule, setNewRule] = useState(false)

  const unacked = events.filter((e) => !e.acked).length

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="microlabel">Detection center</div>
          <div className="mono mt-0.5 text-[13px] text-ink-2">
            {events.length} events · <span style={{ color: unacked ? 'var(--color-warn)' : 'var(--color-ok)' }}>{unacked} open</span> · {rules.filter((r) => r.enabled).length}/{rules.length} rules armed
          </div>
        </div>
        <div className="flex items-center gap-2">
          {view === 'rules' && (
            <button
              onClick={() => setNewRule(true)}
              className="mono flex items-center gap-1.5 border border-ink/30 bg-ink/10 px-2.5 py-1.5 text-[10.5px] tracking-[0.1em] text-ink transition-colors hover:bg-ink/15"
            >
              <Plus size={13} /> NEW RULE
            </button>
          )}
          <div className="flex overflow-hidden border border-line">
            {(
              [
                ['board', Columns3, 'Board'],
                ['table', Table2, 'Table'],
                ['rules', SlidersHorizontal, 'Rules'],
              ] as const
            ).map(([v, Icon, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] transition-colors ${view === v ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:text-ink-2'}`}
              >
                <Icon size={13} strokeWidth={1.5} />
                <span className="mono hidden text-[10px] tracking-[0.08em] sm:block">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === 'board' && <Board events={events} onOpen={setSel} />}

      {view === 'table' && (
        <Panel className="rise overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                {['Time', 'Severity', 'Event', 'Zone / Source', 'Conf', 'Frame', ''].map((h) => (
                  <th key={h} className="microlabel px-3.5 py-2.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => setSel(e)}
                  className={`cursor-pointer border-b border-line/60 transition-colors hover:bg-surface-2 ${Date.now() - e.ts < 8000 ? 'flash-new' : ''} ${e.acked ? 'opacity-50' : ''}`}
                >
                  <td className="mono whitespace-nowrap px-3.5 py-2.5 align-top text-[11px] text-ink-3">
                    {timeShort(e.ts)}
                    <div className="text-[10px] opacity-70">{ago(e.ts, clock)}</div>
                  </td>
                  <td className="px-3.5 py-2.5 align-top">
                    <SevTag sev={e.severity} />
                  </td>
                  <td className="max-w-[320px] px-3.5 py-2.5 align-top">
                    <div className="truncate text-[12.5px] text-ink">{e.label}</div>
                    <div className="truncate text-[11px] text-ink-3">{e.detail}</div>
                  </td>
                  <td className="px-3.5 py-2.5 align-top">
                    <div className="text-[11.5px] text-ink-2">{e.zone}</div>
                    <div className="microlabel mt-0.5">{e.sourceName}</div>
                  </td>
                  <td className="mono px-3.5 py-2.5 align-top text-[11px] text-ink-2">{Math.round(e.confidence * 100)}%</td>
                  <td className="px-3.5 py-2.5 align-top">
                    <Snapshot ev={e} />
                  </td>
                  <td className="px-3.5 py-2.5 align-top">
                    {!e.acked && (
                      <button
                        onClick={(ev) => {
                          ev.stopPropagation()
                          ack(e.id)
                        }}
                        className="mono border border-line-2 px-2 py-1 text-[10px] tracking-[0.08em] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
                      >
                        ACK
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length === 0 && <EmptyNote>No events</EmptyNote>}
        </Panel>
      )}

      {view === 'rules' && (
        <Panel className="rise">
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <span className="microlabel">Detection rules · edge inference</span>
            <span className="mono text-[10px] text-ink-3">disabled rules stop matching detections</span>
          </div>
          {rules.map((r) => (
            <RuleRow key={r.id} r={r} />
          ))}
        </Panel>
      )}

      {sel && <DetailModal ev={sel} onClose={() => setSel(null)} />}
      {newRule && <NewRuleModal onClose={() => setNewRule(false)} />}
    </div>
  )
}
