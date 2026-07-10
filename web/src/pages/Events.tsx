import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Check, X, Plus, Trash2, Columns3, Table2, SlidersHorizontal } from 'lucide-react'
import { useApp, api, useCan } from '../lib/store'
import { useT, useAgo } from '../lib/i18n'
import { timeShort } from '../lib/format'
import { Panel, SevTag, SevDot, EmptyNote, Modal } from '../components/ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { DetectionEvent, DetectionModel, DetectionRule, EventCategory, Severity } from '../lib/types'
import { SEVERITY_COLOR } from '../lib/types'

const MODEL_IDS: DetectionModel[] = ['person', 'smoking', 'thermal', 'ogi', 'gauge', 'ppe', 'motion', 'acoustic']
const CATEGORIES: EventCategory[] = ['security', 'fire', 'env', 'equipment', 'robot-fault']

function CatChip({ cat }: { cat: EventCategory }) {
  const t = useT()
  return (
    <Badge variant="outline" className="px-1 py-px text-[9.5px] tracking-[0.08em]">
      {t(`cat.${cat}`)}
    </Badge>
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
    <Modal onClose={onClose} title={ev.label}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="mono text-[12px] text-ink-3">{ev.id}</span>
          <SevTag sev={ev.severity} />
          <CatChip cat={ev.category} />
        </div>
        <Button variant="ghost" size="iconSm" onClick={onClose} aria-label="close">
          <X size={16} />
        </Button>
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
              <Button
                variant="signal"
                onClick={() => setLifecycle(ev.id, 'acked')}
                className="mono h-auto flex-1 gap-2 py-2 text-[12px] normal-case tracking-[0.1em]"
              >
                <Check size={13} /> {t('c.acknowledge')}
              </Button>
            )}
            <Button
              variant="signal"
              onClick={() => {
                setLifecycle(ev.id, 'resolved')
                onClose()
              }}
              className="mono h-auto flex-1 py-2 text-[12px] normal-case tracking-[0.1em]"
            >
              {t('c.resolve')}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setLifecycle(ev.id, 'dismissed')
                onClose()
              }}
              title={t('ev.dismissHint')}
              className="mono h-auto flex-1 py-2 text-[12px] normal-case tracking-[0.1em]"
            >
              {t('c.dismiss')}
            </Button>
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
        <Button
          variant="outline"
          size="sm"
          onClick={(ev) => {
            ev.stopPropagation()
            ack(e.id)
          }}
          className="mono mt-2 w-full text-[10.5px] normal-case tracking-[0.1em] opacity-0 transition-all group-hover:opacity-100 max-md:opacity-100"
        >
          {t('c.ack')}
        </Button>
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
      <Switch
        checked={r.enabled}
        disabled={!canAdmin}
        onCheckedChange={(on) => api.patchRule(r.id, { enabled: on })}
        title={r.enabled ? 'disable' : 'enable'}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`truncate text-[13.5px] ${r.enabled ? 'text-ink' : 'text-ink-3'}`}>{r.name}</span>
          {!r.builtin && (
            <Badge variant="outline" className="px-1 text-[9.5px]">
              {t('ev.custom')}
            </Badge>
          )}
        </div>
        <div className="microlabel mt-0.5 truncate">
          {modelLabel(r.model)} · {r.sourceName}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="microlabel">conf ≥</span>
        <Slider
          min={0.3}
          max={0.95}
          step={0.05}
          defaultValue={[r.threshold]}
          disabled={!canAdmin}
          onValueCommit={([v]) => api.patchRule(r.id, { threshold: v })}
          className="w-20"
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
        <Button variant="ghost" size="iconSm" onClick={() => api.deleteRule(r.id)} className="hover:bg-transparent hover:text-crit" title="delete">
          <Trash2 size={13} />
        </Button>
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
  const [model, setModel] = useState<string>('person')
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
    <Modal onClose={onClose} title={t('ev.defineRule')}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="microlabel">{t('ev.defineRule')}</span>
        <Button variant="ghost" size="iconSm" onClick={onClose} aria-label="close">
          <X size={16} />
        </Button>
      </div>
      <div className="space-y-3.5 p-4">
        <div>
          <Label className="mb-1.5">{t('ev.ruleName')}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('ev.ruleNamePh')}
            className="mono bg-surface-2 py-2 text-[13px]"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="mb-1.5">{t('ev.model')}</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="mono w-full bg-surface-2 text-[12px] normal-case tracking-normal">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_IDS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`ev.m.${m}`)}
                  </SelectItem>
                ))}
                {customTypes.map((et) => (
                  <SelectItem key={et.id} value={et.id}>
                    {et.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1.5">{t('ev.videoSource')}</Label>
            <Select value={source || undefined} onValueChange={setSource}>
              <SelectTrigger className="mono w-full bg-surface-2 text-[12px] normal-case tracking-normal">
                <SelectValue placeholder={t('ev.select')} />
              </SelectTrigger>
              <SelectContent>
                {sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label className="mb-1.5">{t('ev.zoneLabel')}</Label>
          <Select value={zone || '__site__'} onValueChange={(v) => setZone(v === '__site__' ? '' : v)}>
            <SelectTrigger className="mono w-full bg-surface-2 text-[12px] normal-case tracking-normal">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__site__">{t('ev.siteWide')}</SelectItem>
              {zonesList.map((z) => (
                <SelectItem key={z.id} value={z.name}>
                  {z.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 items-end gap-3">
          <div>
            <Label className="mb-1.5">
              {t('ev.minConf')} · {Math.round(threshold * 100)}%
            </Label>
            <Slider min={0.3} max={0.95} step={0.05} value={[threshold]} onValueChange={([v]) => setThreshold(v)} />
          </div>
          <div>
            <Label className="mb-1.5">{t('ev.severity')}</Label>
            <ToggleGroup
              type="single"
              value={severity}
              onValueChange={(v) => v && setSeverity(v as Severity)}
              className="w-full"
            >
              {(['critical', 'high', 'info', 'low'] as Severity[]).map((s) => (
                <ToggleGroupItem
                  key={s}
                  value={s}
                  className="mono flex-1 text-[10px] tracking-[0.06em] data-[state=on]:bg-surface-3"
                  style={{ color: severity === s ? SEVERITY_COLOR[s] : undefined }}
                >
                  {t(`sev.${s}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
        <Button
          variant="signal"
          disabled={!name.trim() || !source}
          onClick={submit}
          className="mono h-auto w-full py-2.5 text-[12px] normal-case tracking-[0.12em] disabled:opacity-30"
        >
          {t('ev.activate')}
        </Button>
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
                    on ? 'border-(--signal) bg-(--signal) text-[#080808]' : 'border-line text-ink-3 hover:border-line-2 hover:text-ink-2'
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
                className="mono flex items-center gap-1.5 border border-(--signal) bg-(--signal) px-2 py-0.5 text-[10.5px] tracking-[0.06em] text-[#080808] transition-colors hover:brightness-95"
              >
                {filterRule.name} <X size={11} />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {view === 'rules' && canAdmin && (
            <Button
              variant="signal"
              onClick={() => setNewRule(true)}
              className="mono text-[11.5px] normal-case tracking-[0.1em]"
            >
              <Plus size={13} /> {t('ev.newRule')}
            </Button>
          )}
          <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v as View)}>
            {(
              [
                ['board', Columns3, t('ev.board')],
                ['table', Table2, t('ev.table')],
                ['rules', SlidersHorizontal, t('ev.rules')],
              ] as const
            ).map(([v, Icon, label]) => (
              <ToggleGroupItem key={v} value={v} className="gap-1.5 px-2.5 data-[state=on]:bg-surface-2 data-[state=on]:text-ink">
                <Icon size={13} strokeWidth={1.5} />
                <span className="mono hidden text-[11px] tracking-[0.08em] sm:block">{label}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {view === 'board' && <Board events={boardShown} onOpen={setSel} />}

      {view === 'table' && (
        <Panel className="rise overflow-x-auto">
          <Table className="min-w-[820px]">
            <TableHeader>
              <TableRow className="border-line">
                {[t('c.time'), t('ev.severity'), t('ev.event'), t('ev.zoneSource'), t('ev.conf'), t('ev.frame'), ''].map((h, i) => (
                  <TableHead key={i} className="px-3.5 py-2.5">
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((e) => (
                <TableRow
                  key={e.id}
                  onClick={() => setSel(e)}
                  className={`cursor-pointer border-line/60 hover:bg-surface-2 ${Date.now() - e.ts < 8000 ? 'flash-new' : ''} ${e.acked ? 'opacity-50' : ''}`}
                >
                  <TableCell className="mono px-3.5 py-2.5 align-top text-[12px] text-ink-3">
                    {timeShort(e.ts)}
                    <div className="text-[11px] opacity-70">{ago(e.ts, clock)}</div>
                  </TableCell>
                  <TableCell className="px-3.5 py-2.5 align-top">
                    <SevTag sev={e.severity} />
                  </TableCell>
                  <TableCell className="max-w-[320px] whitespace-normal px-3.5 py-2.5 align-top">
                    <div className="truncate text-[13.5px] text-ink">{e.label}</div>
                    <div className="truncate text-[12px] text-ink-3">{e.detail}</div>
                  </TableCell>
                  <TableCell className="px-3.5 py-2.5 align-top">
                    <div className="text-[12.5px] text-ink-2">{e.zone}</div>
                    <div className="microlabel mt-0.5">{e.sourceName}</div>
                  </TableCell>
                  <TableCell className="mono px-3.5 py-2.5 align-top text-[12px] text-ink-2">{Math.round(e.confidence * 100)}%</TableCell>
                  <TableCell className="px-3.5 py-2.5 align-top">
                    <Snapshot ev={e} />
                  </TableCell>
                  <TableCell className="px-3.5 py-2.5 align-top">
                    {!e.acked && canOp && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          ack(e.id)
                        }}
                        className="mono text-[11px] normal-case tracking-[0.08em]"
                      >
                        {t('c.ack')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
