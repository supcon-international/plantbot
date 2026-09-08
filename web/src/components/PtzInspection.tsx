import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Crosshair,
  Download,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch, useCan, useSite } from '../lib/store'
import { useLang } from '../lib/i18n'
import { EmptyNote, Modal, Panel, PanelHead } from './ui'
import { useConfirm } from './ConfirmDialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Switch } from './ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

type Pose = { pan: number; tilt: number; zoom: number }
type Preset = Pose & { id: string; name: string; channelId: string }
type Cadence =
  | { kind: 'once'; at: number }
  | { kind: 'interval'; everyMin: number }
  | { kind: 'weekly'; days: number[]; at: string }
type Plan = {
  id: string
  name: string
  channelId: string
  steps: { presetId: string; dwellS: number }[]
  cadence: Cadence
  enabled: boolean
  nextRunAt?: number
}
type Step = Pose & {
  name: string
  dwellS: number
  orderId?: string
  sentAt?: number
  arrivedAt?: number
  completedAt?: number
  note?: string
}
type Run = {
  id: string
  name: string
  channelId: string
  robotId: string
  by: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  mode: string
  interlocked?: boolean
  steps: Step[]
  stepIndex: number
  startedAt: number
  endedAt?: number
  note?: string
}
type Camera = {
  id: string
  label: string
  robotId: string
  ptz?: { absolute: boolean; pan: [number, number]; tilt: [number, number]; zoom: [number, number] }
}
type Data = { channels: Camera[]; presets: Preset[]; plans: Plan[]; runs: Run[]; interlocks: Run[]; timezone: string }
const empty: Data = { channels: [], presets: [], plans: [], runs: [], interlocks: [], timezone: 'UTC' }
const localTime = (ts: number) => {
  const d = new Date(ts)
  return new Date(ts - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-[12px] text-ink-2">
      {label}
      {children}
    </label>
  )
}
function Choice({
  value,
  onChange,
  label,
  options,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  options: { value: string; label: string }[]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Self-contained, site-scoped panel for LIVE; all requests respect WEB_BASE. */
export function PtzInspection() {
  const siteId = useSite((s) => s.siteId)
  return <PtzPanel key={siteId} siteId={siteId} />
}
function PtzPanel({ siteId }: { siteId: string }) {
  const lang = useLang((s) => s.lang),
    zh = lang === 'zh'
  const l = (en: string, cn: string) => (zh ? cn : en)
  const can = useCan('operator'),
    confirm = useConfirm()
  const [data, setData] = useState<Data>(empty),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState('')
  const [archive, setArchive] = useState<{ runs: Run[]; nextCursor: number | null } | null>(null),
    [since, setSince] = useState(''),
    [until, setUntil] = useState('')
  const [selected, setSelected] = useState(''),
    [tab, setTab] = useState('presets'),
    [busy, setBusy] = useState(false)
  const [preset, setPreset] = useState<Partial<Preset> | null>(null),
    [plan, setPlan] = useState<Partial<Plan> | null>(null),
    [record, setRecord] = useState<Run | null>(null)
  const call = useCallback(
    async (path = '', method = 'GET', body?: unknown) => {
      const response = await apiFetch(`/api/sites/${encodeURIComponent(siteId)}/ptz${path}`, {
        method,
        ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      const json = await response.json()
      if (!response.ok) throw new Error(json.error ?? json.message ?? `HTTP ${response.status}`)
      return json
    },
    [siteId],
  )
  const reload = useCallback(async () => {
    const next = (await call()) as Data
    if (useSite.getState().siteId === siteId) {
      setData(next)
      setError('')
      setLoaded(true)
    }
  }, [call, siteId])
  useEffect(() => {
    let dead = false
    const refresh = async () => {
      try {
        const next = (await call()) as Data
        if (!dead) {
          setData(next)
          setLoaded(true)
          setError('')
        }
      } catch (e) {
        if (!dead) {
          setError((e as Error).message)
          setLoaded(true)
        }
      }
    }
    void refresh()
    const timer = setInterval(() => {
      if (!document.hidden) void refresh()
    }, 2000)
    return () => {
      dead = true
      clearInterval(timer)
    }
  }, [call])
  const cameraId = data.channels.some((c) => c.id === selected)
    ? selected
    : (data.channels.find((c) => c.ptz)?.id ?? data.channels[0]?.id ?? '')
  const camera = data.channels.find((c) => c.id === cameraId),
    absolute = !!camera?.ptz?.absolute
  const presets = data.presets.filter((p) => p.channelId === cameraId),
    plans = data.plans.filter((p) => p.channelId === cameraId),
    runs = archive?.runs ?? data.runs.filter((r) => r.channelId === cameraId)
  const active = data.runs.find((r) => r.channelId === cameraId && r.status === 'running')
  const interlock = data.interlocks?.find((r) => r.channelId === cameraId)
  useEffect(() => setArchive(null), [cameraId])
  async function searchRecords(more = false) {
    setBusy(true)
    try {
      const query = new URLSearchParams({ channelId: cameraId, limit: '100' })
      if (since) query.set('since', String(new Date(since).getTime()))
      if (until) query.set('until', String(new Date(until).getTime() + 86399999))
      if (more && archive?.nextCursor) query.set('before', String(archive.nextCursor))
      const result = await call(`/runs?${query}`)
      setArchive({
        runs: more ? [...(archive?.runs ?? []), ...result.runs] : result.runs,
        nextCursor: result.nextCursor,
      })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function releaseControl(run: Run) {
    if (
      await confirm({
        title: l('Verify camera before releasing control', '确认摄像头状态后解除占用'),
        message: l(
          'Confirm you have checked the camera has stopped and its position is safe. This only releases the platform reservation; it does not send a stop command.',
          '请确认已经检查摄像头停止，且当前位置安全。此操作仅解除平台占用，不会向摄像头发送停止指令。',
        ),
        confirmText: l('I verified the camera', '已确认摄像头状态'),
      })
    )
      await mutate(`/runs/${run.id}/release`, 'POST', { confirmedStopped: true })
  }
  const date = (ts?: number) =>
    ts
      ? new Date(ts).toLocaleString(zh ? 'zh-CN' : 'en-GB', {
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : '—'
  const status = (r: Run) =>
    ({
      running: l('In progress', '执行中'),
      done: r.mode === 'absolute' ? l('Completed', '已完成') : l('Command accepted', '指令已接受'),
      failed: l('Failed', '失败'),
      cancelled: l('Cancelled', '已取消'),
    })[r.status]
  async function mutate(path: string, method = 'POST', body?: unknown) {
    setBusy(true)
    try {
      const result = await call(path, method, body)
      await reload()
      if (result.run?.status === 'failed') toast.error(result.run.note)
      return result
    } catch (e) {
      toast.error((e as Error).message)
      return null
    } finally {
      setBusy(false)
    }
  }
  async function remove(kind: 'presets' | 'plans', row: Preset | Plan) {
    if (
      await confirm({
        title: l('Delete configuration', '删除配置'),
        message: l(
          `Delete “${row.name}”? Existing inspection records remain available.`,
          `删除“${row.name}”？既有巡检记录仍会保留。`,
        ),
        destructive: true,
      })
    )
      await mutate(`/${kind}/${row.id}`, 'DELETE')
  }
  async function cancel(run: Run) {
    if (
      await confirm({
        title: l('Cancel inspection', '取消巡检'),
        message: l(
          'Stop all further stops. A command already delivered to the camera cannot be physically recalled.',
          '停止后续预置点动作。已经下发给摄像头的动作无法物理撤回。',
        ),
      })
    )
      await mutate(`/runs/${run.id}/cancel`)
  }
  function exportRuns() {
    const cell = (v: unknown) => {
      const text = String(v ?? '')
      return `"${(/^[\s]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`
    }
    const rows = [
      ['ID', 'Name', 'Status', 'Operator', 'Started', 'Ended', 'Completed stops', 'Total stops', 'Note'],
      ...runs.map((r) => [
        r.id,
        r.name,
        r.status,
        r.by,
        new Date(r.startedAt).toISOString(),
        r.endedAt ? new Date(r.endedAt).toISOString() : '',
        r.steps.filter((s) => s.completedAt).length,
        r.steps.length,
        r.note,
      ]),
    ]
    const url = URL.createObjectURL(
      new Blob(['\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = `ptz-${siteId}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }
  const cadenceText = (p: Plan) =>
    p.cadence.kind === 'interval'
      ? l(`Every ${p.cadence.everyMin} min`, `每 ${p.cadence.everyMin} 分钟`)
      : p.cadence.kind === 'once'
        ? date(p.cadence.at)
        : `${p.cadence.days.map((d) => l(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d], ['日', '一', '二', '三', '四', '五', '六'][d])).join(' / ')} ${p.cadence.at} UTC`
  const iconButton = (label: string, icon: ReactNode, run: () => void, disabled = false) => (
    <Button
      type="button"
      variant="utility"
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={run}
    >
      {icon}
    </Button>
  )
  return (
    <Panel className="mt-4 overflow-hidden" data-testid="ptz-inspection">
      <PanelHead
        label={
          <span className="flex items-center gap-2">
            <Crosshair size={15} />
            {l('Camera inspection', '云台巡检')}
          </span>
        }
        right={<Badge variant="outline">{l('Presets · plans · records', '预置点 · 计划 · 记录')}</Badge>}
      />
      <div className="space-y-4 p-4">
        {error && (
          <div role="alert" className="border border-line p-3 text-[12px] text-ink-2">
            {l('Could not load camera inspection: ', '无法加载云台巡检：')}
            {error}
            <Button variant="ghost" onClick={() => void reload().catch((e) => setError(e.message))}>
              {l('Retry', '重试')}
            </Button>
          </div>
        )}
        {!loaded ? (
          <div
            className="h-24 animate-pulse bg-surface-2"
            aria-label={l('Loading camera inspection', '加载云台巡检')}
          />
        ) : !camera ? (
          <EmptyNote>
            {l(
              'Connect a robot camera to configure its inspection presets and plans.',
              '接入机器人摄像头后，可配置预置点和巡检计划。',
            )}
          </EmptyNote>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1 md:max-w-lg">
                <Choice
                  value={cameraId}
                  onChange={setSelected}
                  label={l('Inspection camera', '巡检摄像头')}
                  options={data.channels.map((c) => ({ value: c.id, label: c.label }))}
                />
              </div>
              <Badge variant="outline">
                {absolute
                  ? l('Absolute positioning', '绝对定位')
                  : camera.ptz
                    ? l('Reset only', '仅复位')
                    : l('Video only', '仅视频')}
              </Badge>
            </div>
            {!absolute && (
              <p className="max-w-4xl text-[12px] leading-relaxed text-ink-2">
                {camera.ptz
                  ? l(
                      'This adapter exposes a documented reset command. You can prepare presets and disabled plans; repeatable preset inspection requires an adapter with absolute positioning and arrival feedback.',
                      '此适配器支持已公开的复位指令。可准备预置点和停用的计划；要准确巡检预置点，需接入支持绝对定位与到位回执的适配器。',
                    )
                  : l(
                      'This adapter does not declare camera control. Presets and plans can be prepared, but execution stays unavailable until absolute positioning is connected.',
                      '此适配器未声明云台控制能力。可先配置预置点和计划，接入绝对定位能力后才能执行。',
                    )}
              </p>
            )}
            {camera.ptz && !absolute && can && (
              <div className="flex flex-wrap items-center gap-3 border border-line bg-surface-2 p-3">
                <Button
                  variant="utility"
                  disabled={busy || !!active || !!interlock}
                  onClick={() => {
                    void mutate('/manual', 'POST', { channelId: cameraId, mode: 'home' })
                    setTab('records')
                  }}
                >
                  <RotateCcw />
                  {l('Reset camera', '云台复位')}
                </Button>
                <span className="max-w-3xl text-[12px] text-ink-3">
                  {l(
                    'Directional and zoom movement are unavailable until the vendor stop command is verified. Reset acceptance does not verify position.',
                    '厂商停止指令尚未确认，暂不开放方向与缩放移动。复位指令被接受不代表已验证到位。',
                  )}
                </span>
              </div>
            )}
            {interlock && (
              <div className="flex flex-wrap items-center justify-between gap-2 border border-line bg-surface-2 p-3">
                <p className="max-w-3xl text-[12px] text-ink-2">
                  {l(
                    'Camera position is uncertain after interrupted control. Check that the camera has stopped before releasing its reservation.',
                    '控制中断后摄像头位置无法确认。请检查摄像头已经停止，再解除占用。',
                  )}
                </p>
                {can && (
                  <Button variant="outline" disabled={busy} onClick={() => void releaseControl(interlock)}>
                    {l('Verify and release', '确认并解除占用')}
                  </Button>
                )}
              </div>
            )}
            {active && (
              <div className="flex flex-wrap items-center justify-between gap-2 border border-line p-3">
                <span className="flex items-center gap-2 text-[12px]">
                  <span className="live-dot" />
                  {active.name} · {Math.min(active.stepIndex + 1, active.steps.length)}/{active.steps.length} ·{' '}
                  {active.steps[active.stepIndex]?.arrivedAt
                    ? l('Dwelling', '停留中')
                    : l('Waiting for adapter acknowledgement', '等待适配器回执')}
                </span>
                {can && (
                  <Button variant="outline" disabled={busy} onClick={() => void cancel(active)}>
                    <Square />
                    {l('Cancel', '取消')}
                  </Button>
                )}
              </div>
            )}
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="presets">
                  {l('Presets', '预置点')} · {presets.length}
                </TabsTrigger>
                <TabsTrigger value="plans">
                  {l('Inspection plans', '巡检计划')} · {plans.length}
                </TabsTrigger>
                <TabsTrigger value="records">
                  {l('Records', '执行记录')} · {runs.length}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="presets" className="mt-2 space-y-3">
                <div className="flex justify-end">
                  {can && (
                    <Button
                      variant="signal"
                      onClick={() =>
                        setPreset({
                          channelId: cameraId,
                          name: '',
                          pan: 0,
                          tilt: 0,
                          zoom: Math.max(1, camera.ptz?.zoom[0] ?? 1),
                        })
                      }
                    >
                      <Plus />
                      {l('New preset', '新建预置点')}
                    </Button>
                  )}
                </div>
                {!presets.length ? (
                  <EmptyNote>
                    {l(
                      'Name a view and save its pan, tilt and zoom. Add these views to an ordered inspection plan.',
                      '为视角命名并保存水平角、俯仰角与变倍，再按顺序加入巡检计划。',
                    )}
                  </EmptyNote>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{l('Preset', '预置点')}</TableHead>
                        <TableHead>{l('Pan / tilt', '水平 / 俯仰')}</TableHead>
                        <TableHead>{l('Zoom', '变倍')}</TableHead>
                        <TableHead className="text-right">{l('Actions', '操作')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {presets.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell>{p.name}</TableCell>
                          <TableCell className="mono">
                            {p.pan}° / {p.tilt}°
                          </TableCell>
                          <TableCell className="mono">{p.zoom}×</TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              {can && (
                                <>
                                  <Button
                                    variant="utility"
                                    disabled={!absolute || !!active || !!interlock || busy}
                                    title={
                                      !absolute ? l('Absolute positioning required', '需要绝对定位能力') : undefined
                                    }
                                    onClick={() => {
                                      void mutate(`/presets/${p.id}/recall`)
                                      setTab('records')
                                    }}
                                  >
                                    <Crosshair />
                                    {l('Recall', '调用')}
                                  </Button>
                                  {iconButton(l(`Edit ${p.name}`, `编辑 ${p.name}`), <Pencil />, () =>
                                    setPreset({ ...p }),
                                  )}
                                  {iconButton(
                                    l(`Delete ${p.name}`, `删除 ${p.name}`),
                                    <Trash2 />,
                                    () => void remove('presets', p),
                                  )}
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>
              <TabsContent value="plans" className="mt-2 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[12px] text-ink-3">
                    {l(
                      'Ordered stops with arrival receipts and dwell timing. This tour does not capture images or run detection.',
                      '按顺序定位，到位回执后计时停留；本巡检不自动抓拍或执行检测算法。',
                    )}
                  </p>
                  {can && (
                    <Button
                      variant="signal"
                      disabled={!presets.length}
                      onClick={() =>
                        setPlan({
                          channelId: cameraId,
                          name: '',
                          steps: presets[0] ? [{ presetId: presets[0].id, dwellS: 5 }] : [],
                          enabled: false,
                          cadence: { kind: 'interval', everyMin: 60 },
                        })
                      }
                    >
                      <Plus />
                      {l('New plan', '新建计划')}
                    </Button>
                  )}
                </div>
                {!plans.length ? (
                  <EmptyNote>
                    {l(
                      'Create at least one preset, then arrange stops and choose a schedule.',
                      '先创建预置点，再编排点位顺序并设置执行时间。',
                    )}
                  </EmptyNote>
                ) : (
                  <div className="grid gap-3 lg:grid-cols-2">
                    {plans.map((p) => (
                      <div key={p.id} className="border border-line p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium text-[14px]">{p.name}</div>
                            <div className="mt-1 text-[12px] text-ink-3">{cadenceText(p)}</div>
                          </div>
                          <Badge variant="outline">
                            {p.enabled ? l('Enabled', '已启用') : l('Disabled', '已停用')}
                          </Badge>
                        </div>
                        <ol className="my-3 space-y-1 text-[12px] text-ink-2">
                          {p.steps.map((s, i) => (
                            <li key={i}>
                              <span className="mono mr-2 text-ink-3">{String(i + 1).padStart(2, '0')}</span>
                              {data.presets.find((a) => a.id === s.presetId)?.name ??
                                l('Missing preset', '预置点已缺失')}
                              <span className="mono ml-2 text-ink-3">{s.dwellS}s</span>
                            </li>
                          ))}
                        </ol>
                        {p.enabled && (
                          <p className="mb-3 text-[11px] text-ink-3">
                            {l('Next: ', '下次：')}
                            {date(p.nextRunAt)}
                          </p>
                        )}
                        {can && (
                          <div className="flex items-center justify-between gap-2">
                            <label className="flex items-center gap-2 text-[12px]">
                              <Switch
                                aria-label={l(`Enable ${p.name}`, `启用 ${p.name}`)}
                                checked={p.enabled}
                                disabled={busy || !absolute}
                                onCheckedChange={(enabled) => void mutate(`/plans/${p.id}`, 'PUT', { ...p, enabled })}
                              />
                              {l('Schedule', '定时执行')}
                            </label>
                            <div className="flex gap-1">
                              <Button
                                variant="utility"
                                disabled={!absolute || !!active || !!interlock || busy}
                                onClick={() => {
                                  void mutate(`/plans/${p.id}/run`)
                                  setTab('records')
                                }}
                              >
                                <Play />
                                {l('Run now', '立即执行')}
                              </Button>
                              {iconButton(l(`Edit ${p.name}`, `编辑 ${p.name}`), <Pencil />, () =>
                                setPlan({ ...p, steps: p.steps.map((s) => ({ ...s })) }),
                              )}
                              {iconButton(
                                l(`Delete ${p.name}`, `删除 ${p.name}`),
                                <Trash2 />,
                                () => void remove('plans', p),
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
              <TabsContent value="records" className="mt-2 space-y-3">
                <div className="flex flex-wrap items-end gap-2">
                  <Field label={l('From', '开始日期')}>
                    <Input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
                  </Field>
                  <Field label={l('To', '结束日期')}>
                    <Input type="date" value={until} min={since} onChange={(e) => setUntil(e.target.value)} />
                  </Field>
                  <Button variant="outline" disabled={busy} onClick={() => void searchRecords()}>
                    {l('Search archive', '查询归档')}
                  </Button>
                  {archive && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setArchive(null)
                        setSince('')
                        setUntil('')
                      }}
                    >
                      {l('Return to live records', '返回最新记录')}
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[12px] text-ink-3">
                    {l(
                      'Latest 100 site records; search the archive for earlier records. Success requires adapter feedback.',
                      '默认显示场站最近 100 条记录，可查询更早归档；成功状态来自适配器回执。',
                    )}
                  </p>
                  <Button variant="outline" disabled={!runs.length} onClick={exportRuns}>
                    <Download />
                    {l('Export CSV', '导出 CSV')}
                  </Button>
                </div>
                {!runs.length ? (
                  <EmptyNote>
                    {l(
                      'Run a preset or inspection plan to create its first execution record.',
                      '调用预置点或执行巡检计划后，这里会出现执行记录。',
                    )}
                  </EmptyNote>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{l('Inspection', '巡检')}</TableHead>
                        <TableHead>{l('Status', '状态')}</TableHead>
                        <TableHead>{l('Started', '开始时间')}</TableHead>
                        <TableHead>{l('Operator', '操作人')}</TableHead>
                        <TableHead>{l('Details', '详情')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>
                            {r.name}
                            <div className="text-[11px] text-ink-3">
                              {r.steps.filter((s) => s.completedAt).length}/{r.steps.length} {l('stops', '个点位')}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{status(r)}</Badge>
                          </TableCell>
                          <TableCell className="mono text-[11px]">{date(r.startedAt)}</TableCell>
                          <TableCell>{r.by === 'schedule' ? l('Schedule', '定时计划') : r.by}</TableCell>
                          <TableCell>
                            <Button variant="ghost" onClick={() => setRecord(r)}>
                              {l('View record', '查看记录')}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {archive?.nextCursor && (
                  <Button variant="outline" disabled={busy} onClick={() => void searchRecords(true)}>
                    {l('Load earlier records', '加载更早记录')}
                  </Button>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
      {preset && (
        <Modal title={l('Inspection preset', '巡检预置点')} onClose={() => !busy && setPreset(null)}>
          <form
            className="space-y-4 p-5"
            onSubmit={async (e) => {
              e.preventDefault()
              if (await mutate(`/presets${preset.id ? `/${preset.id}` : ''}`, preset.id ? 'PUT' : 'POST', preset))
                setPreset(null)
            }}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-(family-name:--font-condensed) text-xl">
                {preset.id ? l('Edit preset', '编辑预置点') : l('New preset', '新建预置点')}
              </h2>
              {iconButton(l('Close', '关闭'), <X />, () => setPreset(null))}
            </div>
            <Field label={l('Preset name', '预置点名称')}>
              <Input
                autoFocus
                required
                maxLength={100}
                value={preset.name ?? ''}
                onChange={(e) => setPreset({ ...preset, name: e.target.value })}
              />
            </Field>
            <p className="text-[12px] text-ink-3">{camera?.label}</p>
            <div className="grid grid-cols-3 gap-3">
              {(['pan', 'tilt', 'zoom'] as const).map((axis) => (
                <Field
                  key={axis}
                  label={
                    axis === 'pan'
                      ? l('Pan (°)', '水平角（°）')
                      : axis === 'tilt'
                        ? l('Tilt (°)', '俯仰角（°）')
                        : l('Zoom (×)', '变倍（×）')
                  }
                >
                  <Input
                    aria-label={
                      axis === 'pan' ? l('Pan', '水平角') : axis === 'tilt' ? l('Tilt', '俯仰角') : l('Zoom', '变倍')
                    }
                    required
                    type="number"
                    step="0.1"
                    min={absolute ? camera?.ptz?.[axis][0] : axis === 'zoom' ? 1 : axis === 'pan' ? -360 : -180}
                    max={absolute ? camera?.ptz?.[axis][1] : axis === 'zoom' ? 100 : axis === 'pan' ? 360 : 180}
                    value={preset[axis] ?? ''}
                    onChange={(e) =>
                      setPreset({ ...preset, [axis]: e.target.value === '' ? undefined : Number(e.target.value) })
                    }
                  />
                </Field>
              ))}
            </div>
            <p className="text-[12px] leading-relaxed text-ink-3">
              {l(
                'Use calibrated camera angles and zoom. Saving a preset does not move the camera.',
                '填写已校准的摄像头角度和变倍。保存预置点不会移动摄像头。',
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={() => setPreset(null)}>
                {l('Cancel', '取消')}
              </Button>
              <Button type="submit" variant="signal" disabled={busy}>
                {busy ? l('Saving…', '保存中…') : l('Save preset', '保存预置点')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {plan && (
        <Modal wide title={l('Inspection plan', '巡检计划')} onClose={() => !busy && setPlan(null)}>
          <form
            className="max-h-[82vh] space-y-4 overflow-auto p-5"
            onSubmit={async (e) => {
              e.preventDefault()
              if (await mutate(`/plans${plan.id ? `/${plan.id}` : ''}`, plan.id ? 'PUT' : 'POST', plan)) setPlan(null)
            }}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-(family-name:--font-condensed) text-xl">
                {plan.id ? l('Edit inspection plan', '编辑巡检计划') : l('New inspection plan', '新建巡检计划')}
              </h2>
              {iconButton(l('Close', '关闭'), <X />, () => setPlan(null))}
            </div>
            <Field label={l('Plan name', '计划名称')}>
              <Input
                autoFocus
                required
                maxLength={100}
                value={plan.name ?? ''}
                onChange={(e) => setPlan({ ...plan, name: e.target.value })}
              />
            </Field>
            <div className="space-y-2">
              <div className="flex justify-between text-[12px] text-ink-2">
                <span>{l('Ordered presets', '预置点顺序')}</span>
                <span>{l('Dwell seconds', '停留秒数')}</span>
              </div>
              {plan.steps?.map((s, index) => (
                <div key={index} className="flex items-center gap-2">
                  <span className="mono text-[11px] text-ink-3">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <Choice
                      label={l(`Stop ${index + 1} preset`, `第 ${index + 1} 个预置点`)}
                      value={s.presetId}
                      onChange={(presetId) =>
                        setPlan({ ...plan, steps: plan.steps!.map((a, i) => (i === index ? { ...a, presetId } : a)) })
                      }
                      options={presets.map((p) => ({ value: p.id, label: p.name }))}
                    />
                  </div>
                  <Input
                    className="w-20"
                    aria-label={l(`Stop ${index + 1} dwell seconds`, `第 ${index + 1} 点停留秒数`)}
                    required
                    type="number"
                    min={1}
                    max={3600}
                    value={s.dwellS || ''}
                    onChange={(e) =>
                      setPlan({
                        ...plan,
                        steps: plan.steps!.map((a, i) => (i === index ? { ...a, dwellS: Number(e.target.value) } : a)),
                      })
                    }
                  />
                  {iconButton(
                    l('Move stop up', '上移点位'),
                    <ChevronUp />,
                    () => {
                      const steps = [...plan.steps!]
                      ;[steps[index - 1], steps[index]] = [steps[index], steps[index - 1]]
                      setPlan({ ...plan, steps })
                    },
                    index === 0,
                  )}
                  {iconButton(
                    l('Move stop down', '下移点位'),
                    <ChevronDown />,
                    () => {
                      const steps = [...plan.steps!]
                      ;[steps[index + 1], steps[index]] = [steps[index], steps[index + 1]]
                      setPlan({ ...plan, steps })
                    },
                    index === plan.steps!.length - 1,
                  )}
                  {iconButton(
                    l('Remove stop', '移除点位'),
                    <X />,
                    () => setPlan({ ...plan, steps: plan.steps!.filter((_, i) => i !== index) }),
                    plan.steps!.length === 1,
                  )}
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={(plan.steps?.length ?? 0) >= 100}
                onClick={() =>
                  setPlan({ ...plan, steps: [...(plan.steps ?? []), { presetId: presets[0].id, dwellS: 5 }] })
                }
              >
                <Plus />
                {l('Add stop', '添加点位')}
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={l('Frequency', '执行频率')}>
                <Choice
                  value={plan.cadence?.kind ?? 'interval'}
                  label={l('Frequency', '执行频率')}
                  onChange={(kind) =>
                    setPlan({
                      ...plan,
                      cadence:
                        kind === 'once'
                          ? { kind: 'once', at: Date.now() + 3600000 }
                          : kind === 'weekly'
                            ? { kind: 'weekly', days: [1, 2, 3, 4, 5], at: '09:00' }
                            : { kind: 'interval', everyMin: 60 },
                    })
                  }
                  options={[
                    { value: 'once', label: l('Once', '单次') },
                    { value: 'interval', label: l('Interval', '按间隔') },
                    { value: 'weekly', label: l('Weekly · UTC', '每周 · UTC') },
                  ]}
                />
              </Field>
              {plan.cadence?.kind === 'interval' && (
                <Field label={l('Every (minutes)', '间隔（分钟）')}>
                  <Input
                    required
                    type="number"
                    min={1}
                    max={525600}
                    value={plan.cadence.everyMin || ''}
                    onChange={(e) =>
                      setPlan({ ...plan, cadence: { kind: 'interval', everyMin: Number(e.target.value) } })
                    }
                  />
                </Field>
              )}
              {plan.cadence?.kind === 'once' && (
                <Field label={l('Scheduled time (local)', '执行时间（本地时间）')}>
                  <Input
                    required
                    type="datetime-local"
                    value={Number.isFinite(plan.cadence.at) ? localTime(plan.cadence.at) : ''}
                    onChange={(e) =>
                      setPlan({ ...plan, cadence: { kind: 'once', at: new Date(e.target.value).getTime() } })
                    }
                  />
                </Field>
              )}
              {plan.cadence?.kind === 'weekly' && (
                <Field label={l('Time (UTC)', '时间（UTC）')}>
                  <Input
                    required
                    type="time"
                    value={plan.cadence.at}
                    onChange={(e) =>
                      setPlan({
                        ...plan,
                        cadence: { ...(plan.cadence as Extract<Cadence, { kind: 'weekly' }>), at: e.target.value },
                      })
                    }
                  />
                </Field>
              )}
            </div>
            {plan.cadence?.kind === 'weekly' && (
              <div className="flex flex-wrap gap-1">
                {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                  <Button
                    key={day}
                    type="button"
                    variant={plan.cadence!.kind === 'weekly' && plan.cadence!.days.includes(day) ? 'utility' : 'ghost'}
                    aria-pressed={plan.cadence!.kind === 'weekly' && plan.cadence!.days.includes(day)}
                    onClick={() => {
                      const c = plan.cadence as Extract<Cadence, { kind: 'weekly' }>
                      setPlan({
                        ...plan,
                        cadence: {
                          ...c,
                          days: c.days.includes(day) ? c.days.filter((d) => d !== day) : [...c.days, day],
                        },
                      })
                    }}
                  >
                    {l(
                      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day],
                      ['日', '一', '二', '三', '四', '五', '六'][day],
                    )}
                  </Button>
                ))}
              </div>
            )}
            <label className="flex items-center gap-2 text-[12px]">
              <Switch
                checked={!!plan.enabled}
                disabled={!absolute}
                onCheckedChange={(enabled) => setPlan({ ...plan, enabled })}
              />
              {l('Enable schedule when saved', '保存后启用定时执行')}
            </label>
            <p className="text-[12px] text-ink-3">
              {l(
                'Only one inspection controls a camera at a time. Interval schedules start after the first interval. Weekly times use UTC.',
                '同一摄像头同时只执行一个巡检。间隔计划在首个间隔后开始；每周计划使用 UTC 时间。',
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={() => setPlan(null)}>
                {l('Cancel', '取消')}
              </Button>
              <Button
                type="submit"
                variant="signal"
                disabled={busy || !plan.steps?.length || (plan.cadence?.kind === 'weekly' && !plan.cadence.days.length)}
              >
                {busy ? l('Saving…', '保存中…') : l('Save plan', '保存计划')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {record &&
        (() => {
          const r = data.runs.find((a) => a.id === record.id) ?? record
          return (
            <Modal wide title={l('Inspection record', '巡检记录')} onClose={() => setRecord(null)}>
              <div className="max-h-[82vh] space-y-4 overflow-auto p-5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-(family-name:--font-condensed) text-xl">{r.name}</h2>
                  {iconButton(l('Close', '关闭'), <X />, () => setRecord(null))}
                </div>
                <div className="flex flex-wrap gap-3 text-[12px]">
                  <Badge variant="outline">{status(r)}</Badge>
                  <span>
                    {date(r.startedAt)} → {date(r.endedAt)}
                  </span>
                  <span>{r.by}</span>
                </div>
                <p className="break-all mono text-[10px] text-ink-3">{r.id}</p>
                {r.note && <p className="border border-line p-3 text-[12px] leading-relaxed">{r.note}</p>}
                <div className="space-y-3">
                  {r.steps.map((s, i) => (
                    <div key={i} className="border border-line p-3">
                      <div className="flex justify-between gap-3 text-[13px]">
                        <span>
                          {i + 1}. {s.name}
                        </span>
                        <Badge variant="outline">
                          {s.completedAt
                            ? l('Completed', '已完成')
                            : s.arrivedAt
                              ? l('Dwelling', '停留中')
                              : s.sentAt
                                ? l('Sent', '已下发')
                                : l('Not started', '未开始')}
                        </Badge>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-ink-3">
                        <span>
                          {l('Sent: ', '下发：')}
                          {date(s.sentAt)}
                        </span>
                        <span>
                          {r.mode === 'absolute' ? l('Arrival: ', '到位：') : l('Accepted: ', '接受：')}
                          {date(s.arrivedAt)}
                        </span>
                        <span>
                          {l('Dwell: ', '停留：')}
                          {s.dwellS}s
                        </span>
                        <span>
                          {l('Ended: ', '完成：')}
                          {date(s.completedAt)}
                        </span>
                      </div>
                      {s.note && <p className="mt-2 text-[12px]">{s.note}</p>}
                      {s.orderId && <p className="mt-2 mono text-[10px] text-ink-3">{s.orderId}</p>}
                    </div>
                  ))}
                </div>
                {r.status === 'running' && can && (
                  <Button variant="outline" disabled={busy} onClick={() => void cancel(r)}>
                    <Square />
                    {l('Cancel inspection', '取消巡检')}
                  </Button>
                )}
              </div>
            </Modal>
          )
        })()}
    </Panel>
  )
}
