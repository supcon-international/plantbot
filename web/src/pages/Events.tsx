import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  Checkmark as Check,
  Close as X,
  Add as Plus,
  TrashCan as Trash2,
  Column as Columns3,
  Table as Table2,
  SettingsAdjust as SlidersHorizontal,
  Task as ClipboardList,
} from '@carbon/icons-react'
import { DefectLedger } from '../components/DefectLedger'
import { useAssetText } from '../lib/inspection-assets'
import { useConfirm } from '../components/ConfirmDialog'
import { useApp, api, useCan, useSite } from '../lib/store'
import { useT, useAgo, useLang } from '../lib/i18n'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MonitoringRules } from '../components/MonitoringRules'
import { FrozenRuleDetails } from '../components/FrozenRuleDetails'
import { VisionEvidence, VisionObservationDialog } from '../components/VisionInspection'
import { confidenceText, monitoringRequest, type VisionResult } from '../lib/monitoring'

const MODEL_IDS: DetectionModel[] = [
  'person',
  'smoking',
  'thermal',
  'ogi',
  'gauge',
  'ppe',
  'motion',
  'acoustic',
]
const CATEGORIES: EventCategory[] = ['security', 'fire', 'env', 'equipment', 'robot-fault']

function CatChip({ cat }: { cat: EventCategory }) {
  const t = useT()
  return (
    <Badge variant="outline" className="px-1 py-px text-[12px] tracking-normal">
      {t(`cat.${cat}`)}
    </Badge>
  )
}

/** builtin models carry i18n labels; site-registered custom types carry their own */
function useModelLabel() {
  const t = useT()
  const eventTypes = useApp((s) => s.eventTypes)
  return (m: string) =>
    MODEL_IDS.includes(m) ? t(`ev.m.${m}`) : (eventTypes.find((x) => x.id === m)?.label ?? m)
}

/** evidence image with a broken-file fallback: snapshot files are swept on a
 *  bounded ring (SNAP_KEEP) while events outlive them in SQLite, so an old
 *  event may point at a 404 — show the same placeholder as "no snapshot"
 *  instead of the browser's broken-image glyph */
function useBrokenImage(src?: string) {
  const [broken, setBroken] = useState<string | null>(null)
  return {
    broken: !!src && broken === src,
    onError: () => setBroken(src ?? null),
  }
}

function Snapshot({ ev, size = 'sm' }: { ev: DetectionEvent; size?: 'sm' | 'lg' }) {
  const img = useBrokenImage(ev.snapshot)
  if (!ev.snapshot || img.broken)
    return (
      <div
        className={`flex items-center justify-center border border-line bg-surface-2 text-xs text-ink-3 ${size === 'sm' ? 'h-12 w-20' : 'h-40 w-full'}`}
      >
        {useLang.getState().lang === 'zh' ? '无快照' : 'No snapshot'}
      </div>
    )
  return (
    <img
      src={ev.snapshot}
      alt={ev.label}
      onError={img.onError}
      className={
        size === 'sm'
          ? 'h-12 w-20 border border-line object-cover'
          : 'w-full border border-line object-contain'
      }
      loading="lazy"
    />
  )
}

function CardSnapshot({ src }: { src?: string }) {
  const img = useBrokenImage(src)
  if (!src || img.broken) return null
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={img.onError}
      className="mt-2 h-20 w-full border border-line object-cover"
    />
  )
}

function DetailModal({
  ev,
  onClose,
  onRule,
  onDefect,
  onRefresh,
}: {
  ev: DetectionEvent
  onClose: () => void
  onRule: (id: string) => void
  onDefect: () => void
  onRefresh: () => void
}) {
  const canOp = useCan('operator'),
    setLifecycle = useApp((s) => s.setLifecycle),
    rules = useApp((s) => s.rules),
    channels = useApp((s) => s.channels),
    site = useSite((s) => s.siteId)
  const t = useT(),
    l = useAssetText(),
    ago = useAgo(),
    zh = useLang((s) => s.lang) === 'zh'
  const [observation, setObservation] = useState<VisionResult | null>(null),
    [observationError, setObservationError] = useState(''),
    [showObservation, setShowObservation] = useState(false),
    [frozen, setFrozen] = useState(false)
  const trigger = ev.trigger,
    ruleId = trigger?.ruleId ?? ev.ruleId,
    rule = rules.find((r) => r.id === ruleId)
  const resultId = trigger?.resultId ?? trigger?.observationId
  const readingEv = ev.evidence.find((e) => e.kind === 'reading')?.reading
  const channel = channels.find(
    (c) => c.id === (trigger?.channelId ?? ev.evidence.find((e) => e.channelId)?.channelId),
  )
  useEffect(() => {
    let active = true
    setObservation(null)
    setObservationError('')
    if (trigger?.ruleType === 'vision' && resultId)
      void monitoringRequest<VisionResult | { result: VisionResult }>(
        site,
        `/vision/results/${encodeURIComponent(resultId)}`,
      )
        .then((value) => {
          if (active) setObservation('result' in value ? value.result : value)
        })
        .catch((e) => {
          if (active) setObservationError(e.message)
        })
    return () => {
      active = false
    }
  }, [site, resultId, trigger?.ruleType])
  return (
    <Modal wide onClose={onClose} title={ev.label}>
      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">{ev.label}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <SevTag sev={ev.severity} />
              <CatChip cat={ev.category} />
              <span className="mono text-xs text-ink-3">{ev.id}</span>
            </div>
          </div>
          <Button variant="ghost" size="icon" aria-label={t('c.close')} onClick={onClose}>
            <X size={16} />
          </Button>
        </div>
        <p className="text-sm text-ink-2">{ev.detail}</p>
        {observation ? <VisionEvidence result={observation} /> : <Snapshot ev={ev} size="lg" />}
        {trigger && (
          <div className="grid gap-3 rounded-md border border-line bg-surface-2 p-3 text-sm sm:grid-cols-2">
            <div>
              <div className="text-ink-3">{zh ? '实际触发值' : 'Trigger value'}</div>
              <div className="mono">
                {trigger.value === null
                  ? zh
                    ? '未知'
                    : 'Unknown'
                  : `${trigger.value} ${trigger.unit ?? ''}`}
              </div>
            </div>
            <div>
              <div className="text-ink-3">{zh ? '触发条件' : 'Trigger condition'}</div>
              <div>{trigger.condition}</div>
            </div>
          </div>
        )}
        {!trigger && readingEv && (
          <p className="rounded-md border border-line p-3 text-sm">
            <span className="text-ink-3">{t('ev.evReading')} · </span>
            <span className="mono">
              {readingEv.metric} = {readingEv.value} {readingEv.unit}
            </span>
          </p>
        )}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          {[
            [t('c.time'), `${timeShort(ev.ts)} · ${ago(ev.ts)}`],
            [t('c.zone'), ev.zone || '—'],
            [t('c.source'), ev.sourceName],
            [
              zh ? '模型置信度' : 'Model confidence',
              confidenceText(trigger ? trigger.confidence : ev.confidence, zh),
            ],
            [t('c.status'), t(`lc.${ev.lifecycle}`)],
            [
              zh ? '规则版本' : 'Rule revision',
              trigger?.revision?.toString() ?? (zh ? '未记录' : 'Not recorded'),
            ],
          ].map(([key, value]) => (
            <div key={key}>
              <dt className="text-ink-3">{key}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-2">
          {ruleId && (
            <Button variant="outline" onClick={() => onRule(ruleId)}>
              {zh ? '查看触发规则' : 'View trigger rule'}
              {rule?.name ? ` · ${rule.name}` : ''}
            </Button>
          )}
          {trigger && (
            <Button variant="outline" onClick={() => setFrozen(true)}>
              {zh ? '查看冻结版本' : 'View frozen version'}
              {trigger.revision ? ` · ${trigger.revision}` : ''}
            </Button>
          )}
          {observation && (
            <Button variant="outline" onClick={() => setShowObservation(true)}>
              {zh ? '查看观测' : 'Review observation'}
            </Button>
          )}
          {channel && (
            <Button asChild variant="outline">
              <Link to={`/live?src=${encodeURIComponent(channel.streamKey ?? channel.id)}`}>
                {zh ? '查看视频' : 'View video'}
              </Link>
            </Button>
          )}
        </div>
        {observationError && (
          <p role="alert" className="text-sm text-crit">
            {zh ? '观测记录暂不可用：' : 'Observation unavailable: '}
            {observationError}
          </p>
        )}
        {!channel && (
          <p className="text-xs text-ink-3">
            {zh ? '未关联当前可用视频通道。' : 'No currently available video channel is linked.'}
          </p>
        )}
        {canOp && (ev.lifecycle === 'new' || ev.lifecycle === 'acked') && (
          <div className="flex flex-wrap gap-2">
            {ev.lifecycle === 'new' && (
              <Button variant="signal" onClick={() => void setLifecycle(ev.id, 'acked').then(onRefresh)}>
                <Check size={14} />
                {t('c.acknowledge')}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                setLifecycle(ev.id, 'resolved')
                onClose()
              }}
            >
              {t('c.resolve')}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setLifecycle(ev.id, 'dismissed')
                onClose()
              }}
            >
              {t('c.dismiss')}
            </Button>
          </div>
        )}
        {canOp && (
          <Button variant="outline" onClick={onDefect}>
            <ClipboardList size={14} />
            {l('Report equipment defect', '登记设备缺陷')}
          </Button>
        )}
        {showObservation && observation && (
          <VisionObservationDialog result={observation} onClose={() => setShowObservation(false)} />
        )}
        {frozen && trigger && <FrozenRuleDetails trigger={trigger} onClose={() => setFrozen(false)} />}
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
      className={`group border border-line bg-surface-2/60 p-3 transition-colors hover:border-line-2 ${
        Date.now() - e.ts < 8000 ? 'flash-new' : ''
      } `}
    >
      <Button
        variant="ghost"
        onClick={onOpen}
        aria-label={`${e.label} · ${t('c.detail')}`}
        className="block h-auto w-full whitespace-normal p-0 text-left hover:bg-transparent"
      >
        <div className="flex items-center gap-2">
          <SevDot sev={e.severity} pulse={!e.acked && e.severity === 'critical'} />
          <span className="mono text-[12px] text-ink-3">{ago(e.ts, clock)}</span>
          <span className="mono ml-auto text-[12px] text-ink-3">
            {confidenceText(
              e.trigger ? e.trigger.confidence : e.confidence,
              useLang.getState().lang === 'zh',
            )}
          </span>
        </div>
        <div className="mt-1.5 line-clamp-2 text-[14px] leading-snug text-ink">{e.label}</div>
        <div className="microlabel mt-1 truncate">{e.zone}</div>
        <CardSnapshot src={e.snapshot} />
      </Button>
      {!e.acked && canOp && (
        <Button
          variant="outline"
          size="sm"
          onClick={(ev) => {
            ev.stopPropagation()
            ack(e.id)
          }}
          className="mt-2 w-full text-[12px]"
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
    {
      key: 'crit',
      label: t('ev.col.critical'),
      sevs: ['critical'],
      tone: SEVERITY_COLOR.critical,
    },
    {
      key: 'high',
      label: t('ev.col.high'),
      sevs: ['high'],
      tone: SEVERITY_COLOR.high,
    },
    {
      key: 'routine',
      label: t('ev.col.routine'),
      sevs: ['info', 'low'],
      tone: 'var(--color-ink-3)',
    },
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
              <span className="mono ml-auto text-[12px] text-ink-3">
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

// ---------- page ----------
type View = 'events' | 'rules' | 'defects'
export function Events() {
  const zh = useLang((s) => s.lang) === 'zh',
    t = useT(),
    ago = useAgo(),
    l = useAssetText(),
    site = useSite((s) => s.siteId),
    canOp = useCan('operator')
  const events = useApp((s) => s.events),
    rules = useApp((s) => s.rules),
    ack = useApp((s) => s.ack),
    clock = useApp((s) => s.clock)
  const [params, setParams] = useSearchParams(),
    [view, setView] = useState<View>(
      params.get('view') === 'rules' ? 'rules' : params.get('view') === 'defects' ? 'defects' : 'events',
    ),
    [presentation, setPresentation] = useState(params.get('view') === 'table' ? 'table' : 'board')
  const [selId, setSelId] = useState<string | null>(params.get('ev')),
    [ruleFilter, setRuleFilter] = useState<string | null>(params.get('ruleFilter')),
    [catFilter, setCatFilter] = useState<EventCategory | null>(null)
  const [historical, setHistorical] = useState<DetectionEvent | null>(null),
    [detailError, setDetailError] = useState('')
  const liveEvent = events.find((e) => e.id === selId),
    sel = liveEvent ?? (historical?.id === selId ? historical : null)
  const refreshDetail = () => {
    if (selId && !liveEvent)
      void monitoringRequest<{ event: DetectionEvent }>(site, `/events/${encodeURIComponent(selId)}`)
        .then((d) => setHistorical(d.event))
        .catch((e) => setDetailError(e.message))
  }
  useEffect(() => {
    let active = true
    setHistorical(null)
    setDetailError('')
    if (selId && !liveEvent)
      void monitoringRequest<{ event: DetectionEvent }>(site, `/events/${encodeURIComponent(selId)}`)
        .then((d) => {
          if (active) setHistorical(d.event)
        })
        .catch((e) => {
          if (active) setDetailError(e.message)
        })
    return () => {
      active = false
    }
  }, [site, selId, !!liveEvent])
  useEffect(() => {
    const v = params.get('view')
    setView(v === 'rules' ? 'rules' : v === 'defects' ? 'defects' : 'events')
    if (v === 'table') setPresentation('table')
    if (params.get('ev')) setSelId(params.get('ev'))
    if (params.get('ruleFilter')) setRuleFilter(params.get('ruleFilter'))
  }, [params])
  const closeDetail = () => {
    setSelId(null)
    const next = new URLSearchParams(params)
    next.delete('ev')
    setParams(next, { replace: true })
  }
  const changeView = (v: string) => {
    setView(v as View)
    const next = new URLSearchParams(params)
    next.set('view', v)
    next.delete('ev')
    setSelId(null)
    setParams(next, { replace: true })
  }
  const shown = events.filter(
    (e) =>
      (!ruleFilter || (e.trigger?.ruleId ?? e.ruleId) === ruleFilter) &&
      (!catFilter || e.category === catFilter),
  )
  const unacked = events.filter((e) => e.lifecycle === 'new').length
  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-3 md:p-4">
      <h1 className="text-2xl font-medium">{zh ? '事件与监测' : 'Events & monitoring'}</h1>
      <Tabs value={view} onValueChange={changeView}>
        <TabsList aria-label={zh ? '事件工作区' : 'Events workspace'}>
          <TabsTrigger value="events">{zh ? '事件' : 'Events'}</TabsTrigger>
          <TabsTrigger value="rules">{zh ? '监测规则' : 'Monitoring rules'}</TabsTrigger>
          <TabsTrigger value="defects">{zh ? '缺陷' : 'Defects'}</TabsTrigger>
        </TabsList>
        <TabsContent value="events" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-2">
              {events.length} {t('c.events')} · {unacked} {t('c.open')}
            </p>
            <ToggleGroup
              type="single"
              value={presentation}
              onValueChange={(v) => v && setPresentation(v)}
              aria-label={zh ? '事件显示方式' : 'Event presentation'}
            >
              <ToggleGroupItem value="board" aria-label={t('ev.board')}>
                <Columns3 size={14} />
                <span className="ml-1">{t('ev.board')}</span>
              </ToggleGroupItem>
              <ToggleGroupItem value="table" aria-label={t('ev.table')}>
                <Table2 size={14} />
                <span className="ml-1">{t('ev.table')}</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <Button
                key={c}
                variant={catFilter === c ? 'highlight' : 'outline'}
                size="sm"
                aria-pressed={catFilter === c}
                onClick={() => setCatFilter(catFilter === c ? null : c)}
              >
                {t(`cat.${c}`)}
              </Button>
            ))}
            {ruleFilter && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setRuleFilter(null)
                  const next = new URLSearchParams(params)
                  next.delete('ruleFilter')
                  setParams(next, { replace: true })
                }}
              >
                {rules.find((r) => r.id === ruleFilter)?.name ?? (zh ? '筛选规则' : 'Filtered rule')}
                <X size={12} />
              </Button>
            )}
          </div>
          {presentation === 'board' ? (
            <Board events={shown.filter((e) => e.lifecycle !== 'dismissed')} onOpen={(e) => setSelId(e.id)} />
          ) : (
            <Panel>
              <Table className="min-w-[800px]">
                <TableHeader>
                  <TableRow>
                    {[
                      t('c.time'),
                      t('ev.severity'),
                      t('ev.event'),
                      t('ev.zoneSource'),
                      t('ev.conf'),
                      t('ev.frame'),
                      '',
                    ].map((h, i) => (
                      <TableHead key={i}>{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-xs text-ink-3">
                        {timeShort(e.ts)}
                        <div>{ago(e.ts, clock)}</div>
                      </TableCell>
                      <TableCell>
                        <SevTag sev={e.severity} />
                      </TableCell>
                      <TableCell className="max-w-72 whitespace-normal">
                        <Button
                          variant="ghost"
                          className="h-auto max-w-full whitespace-normal p-0 text-left"
                          onClick={() => setSelId(e.id)}
                        >
                          {e.label}
                        </Button>
                        <div className="mt-1 text-xs text-ink-3">{e.detail}</div>
                      </TableCell>
                      <TableCell className="max-w-48 whitespace-normal text-sm">
                        {e.zone}
                        <div className="text-xs text-ink-3">{e.sourceName}</div>
                      </TableCell>
                      <TableCell className="mono text-xs">
                        {confidenceText(e.trigger ? e.trigger.confidence : e.confidence, zh)}
                      </TableCell>
                      <TableCell>
                        <Snapshot ev={e} />
                      </TableCell>
                      <TableCell>
                        {!e.acked && canOp && (
                          <Button variant="outline" size="sm" onClick={() => ack(e.id)}>
                            {t('c.ack')}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!shown.length && <EmptyNote>{t('ev.noEvents')}</EmptyNote>}
            </Panel>
          )}
        </TabsContent>
        <TabsContent value="rules">
          <MonitoringRules
            key={site}
            onViewEvents={(id) => {
              setRuleFilter(id)
              setPresentation('table')
              setView('events')
              setParams({ view: 'events', ruleFilter: id }, { replace: true })
            }}
          />
        </TabsContent>
        <TabsContent value="defects">
          <DefectLedger initialEvent={events.find((e) => e.id === params.get('fromEvent'))} />
        </TabsContent>
      </Tabs>
      {detailError && (
        <div role="alert" className="text-sm text-crit">
          {zh ? '事件详情暂不可用：' : 'Event details unavailable: '}
          {detailError}
        </div>
      )}
      {sel && (
        <DetailModal
          ev={sel}
          onRefresh={refreshDetail}
          onClose={closeDetail}
          onRule={(id) => {
            setSelId(null)
            setParams({ view: 'rules', rule: id }, { replace: true })
          }}
          onDefect={() => {
            setSelId(null)
            setParams({ view: 'defects', fromEvent: sel.id }, { replace: true })
          }}
        />
      )}
    </div>
  )
}
