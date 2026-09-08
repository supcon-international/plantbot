import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Download, FileText, RefreshCw } from 'lucide-react'
import { sfetch, useApp, useSite } from '../lib/store'
import { useLang, useT } from '../lib/i18n'
import { BASE } from '../lib/base'
import type { Mission } from '../lib/types'
import { Panel, PanelHead, EmptyNote, MissionStatusTag } from './ui'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dateAt = (s: string) => new Date(`${s}T00:00:00`)
const plusDays = (d: Date, n: number) => {
  const result = new Date(d)
  result.setDate(result.getDate() + n)
  return result
}
const useLabels = () => {
  const zh = useLang((s) => s.lang) === 'zh'
  return (en: string, cn: string) => (zh ? cn : en)
}

export function MissionReportActions({ id }: { id: string }) {
  const siteId = useSite((s) => s.siteId),
    l = useLabels()
  const path = `${BASE}/api/sites/${encodeURIComponent(siteId)}/mission-archive/${encodeURIComponent(id)}/report`
  return (
    <span className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" asChild>
        <a href={`${path}?format=html`} target="_blank" rel="noreferrer">
          <FileText size={13} />
          {l('Print report', '打印报告')}
        </a>
      </Button>
      <Button variant="outline" size="sm" asChild>
        <a href={`${path}?format=csv`}>
          <Download size={13} />
          {l('Export CSV', '导出 CSV')}
        </a>
      </Button>
    </span>
  )
}

type Entry = {
  id: string
  kind: 'planned' | 'actual'
  at: number
  name: string
  scheduleId?: string
  runId?: string
  status?: string
  robot?: string
}
export function MissionArchive({
  mode,
  renderDetail,
}: {
  mode: 'calendar' | 'archive'
  renderDetail: (mission: Mission) => ReactNode
}) {
  const l = useLabels(),
    t = useT(),
    siteId = useSite((s) => s.siteId)
  const schedules = useApp((s) => s.schedules)
  const [from, setFrom] = useState(day(plusDays(new Date(), -30))),
    [to, setTo] = useState(day(new Date()))
  const [status, setStatus] = useState('all'),
    [offset, setOffset] = useState(0),
    [page, setPage] = useState<{ missions: Mission[]; total: number }>({ missions: [], total: 0 })
  const [view, setView] = useState('month'),
    [anchor, setAnchor] = useState(day(new Date())),
    [selected, setSelected] = useState(day(new Date()))
  const [calendar, setCalendar] = useState<{ entries: Entry[]; truncated: boolean; timeZone: string }>({
    entries: [],
    truncated: false,
    timeZone: '',
  })
  const [mission, setMission] = useState<Mission | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0)
  const detailRequest = useRef<AbortController | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [events, setEvents] = useState<
    { id: string; label: string; severity: string; lifecycle: string; detail: string }[]
  >([])
  const pivot = dateAt(anchor),
    first =
      view === 'week'
        ? plusDays(pivot, -((pivot.getDay() + 6) % 7))
        : new Date(pivot.getFullYear(), pivot.getMonth(), 1)
  const start = view === 'week' ? first : plusDays(first, -((first.getDay() + 6) % 7)),
    end = plusDays(start, view === 'week' ? 7 : 42)
  const startTs = start.getTime(),
    endTs = end.getTime()
  useEffect(() => {
    detailRequest.current?.abort()
    setMission(null)
    setEvents([])
    setOffset(0)
    setDetailBusy(false)
    return () => detailRequest.current?.abort()
  }, [siteId, mode])
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true)
    setError('')
    const params =
      mode === 'calendar'
        ? new URLSearchParams({ from: String(startTs), to: String(endTs) })
        : new URLSearchParams({
            from: String(dateAt(from).getTime()),
            to: String(plusDays(dateAt(to), 1).getTime()),
            limit: '25',
            offset: String(offset),
            ...(status !== 'all' ? { status } : {}),
          })
    sfetch(`${mode === 'calendar' ? '/mission-calendar' : '/mission-archive'}?${params}`, { signal: controller.signal })
      .then(async (r) => {
        const data = await r.json()
        if (!r.ok) throw new Error(data.error ?? r.statusText)
        if (mode === 'calendar') setCalendar(data)
        else setPage(data)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [siteId, mode, from, to, status, offset, startTs, endTs, revision, schedules.length])
  const openRun = async (id: string) => {
    detailRequest.current?.abort()
    const controller = new AbortController()
    detailRequest.current = controller
    setError('')
    setMission(null)
    setEvents([])
    setDetailBusy(true)
    try {
      const r = await sfetch(`/mission-archive/${encodeURIComponent(id)}`, { signal: controller.signal })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      if (controller.signal.aborted || siteId !== useSite.getState().siteId) return
      setMission(data.mission)
      setEvents(data.events ?? [])
    } catch (e) {
      if (!controller.signal.aborted) setError(String(e))
    } finally {
      if (!controller.signal.aborted) setDetailBusy(false)
    }
  }
  const changeMonth = (n: number) => {
    const d = dateAt(anchor)
    if (view === 'week') d.setDate(d.getDate() + n * 7)
    else {
      d.setDate(1)
      d.setMonth(d.getMonth() + n)
    }
    setAnchor(day(d))
    setSelected(day(d))
  }
  const dayEntries = calendar.entries.filter((e) => day(new Date(e.at)) === selected)
  return (
    <div className="space-y-3">
      <Panel>
        <PanelHead
          label={mode === 'calendar' ? l('Mission calendar', '任务日历') : l('Inspection archive', '巡检归档')}
          right={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRevision((x) => x + 1)}
              disabled={busy}
              aria-label={l('Refresh', '刷新')}
            >
              <RefreshCw size={13} />
            </Button>
          }
        />
        {mode === 'archive' ? (
          <>
            <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
              <div>
                <Label htmlFor="archive-from">{l('Created from', '创建日期从')}</Label>
                <Input
                  id="archive-from"
                  type="date"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value)
                    setOffset(0)
                  }}
                />
              </div>
              <div>
                <Label htmlFor="archive-to">{l('Through', '至')}</Label>
                <Input
                  id="archive-to"
                  type="date"
                  value={to}
                  min={from}
                  onChange={(e) => {
                    setTo(e.target.value)
                    setOffset(0)
                  }}
                />
              </div>
              <div className="min-w-36">
                <Label>{l('Status', '状态')}</Label>
                <Select
                  value={status}
                  onValueChange={(v) => {
                    setStatus(v)
                    setOffset(0)
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{l('All statuses', '全部状态')}</SelectItem>
                    {['queued', 'active', 'done', 'failed', 'aborted'].map((s) => (
                      <SelectItem key={s} value={s}>
                        {t(`ms.${s}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <span className="pb-2 text-xs text-ink-3">
                {l('Stored records, including previous sessions', '保留全部会话的持久巡检记录')}
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{l('Run', '任务')}</TableHead>
                  <TableHead>{l('Created', '创建')}</TableHead>
                  <TableHead>{l('Robot', '机器人')}</TableHead>
                  <TableHead>{l('Status', '状态')}</TableHead>
                  <TableHead>{l('Results', '结果')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.missions.map((m) => (
                  <TableRow key={m.id} className={mission?.id === m.id ? 'bg-surface-2' : ''}>
                    <TableCell>
                      <Button
                        variant="ghost"
                        className="h-auto max-w-80 justify-start whitespace-normal px-0 text-left"
                        onClick={() => openRun(m.id)}
                      >
                        {m.id} · {m.name}
                      </Button>
                    </TableCell>
                    <TableCell className="mono text-xs">{new Date(m.createdAt).toLocaleString()}</TableCell>
                    <TableCell>{m.robotId ?? m.requestedRobot}</TableCell>
                    <TableCell>
                      <MissionStatusTag status={m.status} />
                    </TableCell>
                    <TableCell className="mono">
                      {m.results.length} · {m.results.filter((r) => !r.ok).length} {l('flagged', '异常')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!busy && !page.missions.length && (
              <EmptyNote>{l('No inspection records in this date range.', '此日期范围内没有巡检记录。')}</EmptyNote>
            )}
            <div className="flex items-center justify-between border-t border-line p-3 text-xs">
              <span>
                {page.total} {l('records', '条记录')}
              </span>
              <span className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="iconSm"
                  aria-label={l('Previous page', '上一页')}
                  disabled={!offset || busy}
                  onClick={() => setOffset(Math.max(0, offset - 25))}
                >
                  <ChevronLeft size={14} />
                </Button>
                {Math.floor(offset / 25) + 1} / {Math.max(1, Math.ceil(page.total / 25))}
                <Button
                  variant="ghost"
                  size="iconSm"
                  aria-label={l('Next page', '下一页')}
                  disabled={offset + 25 >= page.total || busy}
                  onClick={() => setOffset(offset + 25)}
                >
                  <ChevronRight size={14} />
                </Button>
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
              <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v)}>
                <ToggleGroupItem value="week">{l('Week', '周')}</ToggleGroupItem>
                <ToggleGroupItem value="month">{l('Month', '月')}</ToggleGroupItem>
              </ToggleGroup>
              <Button
                variant="ghost"
                size="iconSm"
                onClick={() => changeMonth(-1)}
                aria-label={l('Previous period', '上一时段')}
              >
                <ChevronLeft size={15} />
              </Button>
              <Input
                type="date"
                value={anchor}
                aria-label={l('Calendar date', '日历日期')}
                className="w-40"
                onChange={(e) => {
                  if (e.target.value) {
                    setAnchor(e.target.value)
                    setSelected(e.target.value)
                  }
                }}
              />
              <Button
                variant="ghost"
                size="iconSm"
                onClick={() => changeMonth(1)}
                aria-label={l('Next period', '下一时段')}
              >
                <ChevronRight size={15} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAnchor(day(new Date()))
                  setSelected(day(new Date()))
                }}
              >
                {l('Today', '今天')}
              </Button>
              <span className="ml-auto text-xs text-ink-3">
                {l('Planned = forecast · Actual = created run', '计划 = 预计触发 · 实际 = 已创建任务')}
              </span>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[650px]">
                <div className="grid grid-cols-7 border-b border-line">
                  {Array.from({ length: 7 }, (_, i) => (
                    <div className="px-2 py-1.5 text-xs text-ink-3" key={i}>
                      {plusDays(start, i).toLocaleDateString(undefined, { weekday: 'short' })}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7">
                  {Array.from({ length: view === 'week' ? 7 : 42 }, (_, i) => {
                    const d = plusDays(start, i),
                      key = day(d),
                      list = calendar.entries.filter((e) => day(new Date(e.at)) === key),
                      actual = list.filter((e) => e.kind === 'actual').length,
                      planned = list.length - actual
                    return (
                      <Button
                        key={key}
                        variant="ghost"
                        onClick={() => setSelected(key)}
                        aria-pressed={selected === key}
                        aria-label={`${key}, ${actual} ${l('actual', '实际')}, ${planned} ${l('planned', '计划')}`}
                        className={`h-24 flex-col items-start justify-start gap-1 border-r border-b border-line p-2 text-left font-normal ${selected === key ? 'bg-surface-3 ring-1 ring-inset ring-ink-3' : ''} ${d.getMonth() !== pivot.getMonth() && view === 'month' ? 'text-ink-3' : ''}`}
                      >
                        <span className={key === day(new Date()) ? 'font-bold underline underline-offset-4' : ''}>
                          {d.getDate()}
                        </span>
                        {actual > 0 && (
                          <span className="text-[11px]">
                            {actual} {l('actual', '实际')}
                          </span>
                        )}
                        {planned > 0 && (
                          <span className="text-[11px] text-ink-3">
                            {planned} {l('planned', '计划')}
                          </span>
                        )}
                      </Button>
                    )
                  })}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap justify-between gap-2 p-3 text-xs text-ink-3">
              <span>
                {l('Displayed in your local time. Schedule time zone:', '按浏览器本地时间展示。排程时区：')}{' '}
                {calendar.timeZone}
              </span>
              {calendar.truncated && (
                <span className="text-warn">
                  {l(
                    'Dense schedule: showing the first 5,000 planned and actual entries. Use week view.',
                    '排程密集：最多显示各 5,000 条计划及实际任务，请切换周视图。',
                  )}
                </span>
              )}
            </div>
            <div className="border-t border-line">
              <PanelHead
                label={
                  <span className="flex items-center gap-2">
                    <CalendarDays size={13} />
                    {selected} · {dayEntries.length}
                  </span>
                }
              />
              <div className="max-h-72 overflow-y-auto">
                {dayEntries.map((e) => (
                  <div key={e.id} className="flex items-center gap-3 border-b border-line/50 px-3 py-2 text-xs">
                    <span className="mono text-ink-3">
                      {new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className={`w-16 shrink-0 ${e.kind === 'planned' ? 'text-ink-3' : ''}`}>
                      {e.kind === 'planned' ? l('Planned', '计划') : l('Actual', '实际')}
                    </span>
                    {e.runId ? (
                      <Button
                        variant="ghost"
                        className="h-auto min-w-0 justify-start px-0 text-left"
                        onClick={() => openRun(e.runId!)}
                      >
                        {e.name}
                      </Button>
                    ) : (
                      <span>{e.name}</span>
                    )}
                    <span className="ml-auto shrink-0 text-ink-3">{e.status ? t(`ms.${e.status}`) : e.scheduleId}</span>
                  </div>
                ))}
                {!dayEntries.length && (
                  <EmptyNote>{l('No runs or future schedules for this day.', '当天没有任务或未来排程。')}</EmptyNote>
                )}
              </div>
            </div>
          </>
        )}
        {busy && (
          <div className="p-3 text-xs text-ink-3" role="status">
            {l('Loading records…', '正在读取记录…')}
          </div>
        )}
        {error && (
          <div className="p-3 text-sm text-crit" role="alert">
            {error}
          </div>
        )}
      </Panel>
      {detailBusy && (
        <p role="status" className="text-xs text-ink-3">
          {l('Loading inspection details…', '正在读取巡检详情…')}
        </p>
      )}
      {mission && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">
              {mission.id} · {mission.name}
            </span>
            <MissionReportActions id={mission.id} />
          </div>
          {renderDetail(mission)}
          <Panel>
            <PanelHead label={`${l('Linked events', '关联事件')} · ${events.length}`} />
            {events.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{l('Event', '事件')}</TableHead>
                    <TableHead>{l('Severity / status', '等级 / 状态')}</TableHead>
                    <TableHead>{l('Detail', '详情')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        {e.id} · {e.label}
                      </TableCell>
                      <TableCell>
                        {e.severity} / {e.lifecycle}
                      </TableCell>
                      <TableCell>{e.detail}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyNote>{l('No events linked to this run.', '此任务没有关联事件。')}</EmptyNote>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
