import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Add as Plus, Edit as Pencil, TrashCan as Trash2, Close as X, Play, Renew as RefreshCw } from '@carbon/icons-react'
import { toast } from 'sonner'
import { apiFetch, useCan, useSite } from '../lib/store'
import { useLang } from '../lib/i18n'
import { EmptyNote, Modal, Panel, PanelHead } from './ui'
import { useConfirm } from './ConfirmDialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { Badge } from './ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

type Point = [number, number]
type Config = {
  id?: string
  revision?: number
  name: string
  preset: string
  adapterId: string
  sourceId: string
  enabled: boolean
  region: Point[]
  line: Point[]
  direction: string
  threshold: number
  durationS: number
  confidence: number
  intervalS: number
  severity: string
  schedule: { days: number[]; start: string; end: string } | null
  assetId: string
  numeric: boolean
  unit: string
  min: number | null
  max: number | null
}
type Preset = {
  id: string
  en: string
  zh: string
  engine: string
  rule: string
}
type Result = {
  id: string
  config: Config
  adapterId: string
  capturedAt: number
  status: string
  value: number | null
  text: string
  note: string
  evidence: string
  model: string
  late: boolean
  jobId?: string
  annotations: { label: string; box: number[]; score: number }[]
}
type Adapter = {
  id: string
  name: string
  online: boolean
  sources: {
    id: string
    label: string
    view: string
    status: string
    note: string
  }[]
  models: { detector: string; ocr: string }
}
type Data = {
  presets: Preset[]
  configs: Config[]
  adapters: Adapter[]
  results: Result[]
  jobs: { id: string; status: string; resultId?: string }[]
}
const empty: Data = {
  presets: [],
  configs: [],
  adapters: [],
  results: [],
  jobs: [],
}
const region: Point[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]
const makeConfig = (p: Preset, a?: Adapter): Config => ({
  name: '',
  preset: p.id,
  adapterId: a?.id ?? '',
  sourceId: a?.sources[0]?.id ?? '',
  enabled: false,
  region: region.map((p) => [...p]),
  line: [
    [0.5, 0.1],
    [0.5, 0.9],
  ],
  direction: 'both',
  threshold: p.rule === 'below' ? 1 : p.id === 'crowding' ? 3 : 0,
  durationS: p.rule === 'dwell' || p.rule === 'stationary' ? 60 : 3,
  confidence: 0.5,
  intervalS: 15,
  severity: 'high',
  schedule: null,
  assetId: '',
  numeric: false,
  unit: '',
  min: null,
  max: null,
})
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm text-ink-2">
      {label}
      {children}
    </label>
  )
}
function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <Field label={label}>
      <Select value={value || '_'} onValueChange={(v) => onChange(v === '_' ? '' : v)}>
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value || '_'}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function Evidence({
  result,
  children,
  overlay = true,
}: {
  result?: Result
  children?: ReactNode
  overlay?: boolean
}) {
  return (
    <div className="relative overflow-hidden border border-line bg-bg-2">
      {result?.evidence ? (
        <img src={result.evidence} alt={result.config.name} className="block w-full" />
      ) : (
        <div className="aspect-video flex items-center justify-center p-5 text-center text-sm text-ink-3">
          {children ? '' : '—'}
        </div>
      )}
      {result?.evidence && overlay && (
        <svg
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          {result.annotations.map((a, i) => (
            <g key={i}>
              <rect
                x={a.box[0] * 1000}
                y={a.box[1] * 1000}
                width={(a.box[2] - a.box[0]) * 1000}
                height={(a.box[3] - a.box[1]) * 1000}
                fill="none"
                stroke="#ffbf47"
                strokeWidth="3"
              />
              <text
                x={a.box[0] * 1000 + 4}
                y={Math.max(20, a.box[1] * 1000 - 8)}
                fill="#ffbf47"
                fontSize="22"
              >
                {a.label} {Math.round(a.score * 100)}%
              </text>
            </g>
          ))}
        </svg>
      )}
      {children}
    </div>
  )
}

function Geometry({
  config,
  set,
  result,
  zh,
}: {
  config: Config
  set: (c: Config) => void
  result?: Result
  zh: boolean
}) {
  const [mode, setMode] = useState('region')
  const drag = useRef<number | null>(null)
  const line = mode === 'line',
    points = line ? config.line : config.region
  const update = (i: number, p: Point) =>
    set({
      ...config,
      [mode]: points.map((v, j) => (j === i ? p.map((n) => Math.max(0, Math.min(1, n))) : v)),
    })
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">{zh ? '检测区域与计数线' : 'Region & counting line'}</span>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setMode(line ? 'region' : 'line')}>
            {line ? (zh ? '编辑区域' : 'Edit region') : zh ? '编辑计数线' : 'Edit line'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              set({
                ...config,
                region: region.map((p) => [...p]),
                line: [
                  [0.5, 0.1],
                  [0.5, 0.9],
                ],
              })
            }
          >
            {zh ? '重置' : 'Reset'}
          </Button>
        </div>
      </div>
      <Evidence result={result} overlay={false}>
        <svg
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full touch-none"
          aria-label={zh ? '检测区域编辑器' : 'Detection geometry editor'}
          onPointerMove={(e) => {
            if (drag.current === null) return
            const b = e.currentTarget.getBoundingClientRect()
            update(drag.current, [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height])
          }}
          onPointerUp={() => {
            drag.current = null
          }}
          onPointerCancel={() => {
            drag.current = null
          }}
        >
          <polygon
            points={config.region.map((p) => p.map((n) => n * 1000).join(',')).join(' ')}
            fill="#ffbf4718"
            stroke="#ffbf47"
            strokeWidth="3"
          />
          <line
            x1={config.line[0][0] * 1000}
            y1={config.line[0][1] * 1000}
            x2={config.line[1][0] * 1000}
            y2={config.line[1][1] * 1000}
            stroke="#6bc5ff"
            strokeWidth="4"
          />
          {points.map((p, i) => (
            <circle
              key={`${mode}-${i}`}
              cx={Math.max(12, Math.min(988, p[0] * 1000))}
              cy={Math.max(12, Math.min(988, p[1] * 1000))}
              r="14"
              fill={line ? '#6bc5ff' : '#ffbf47'}
              stroke="#000"
              strokeWidth="2"
              role="slider"
              tabIndex={0}
              aria-label={`${line ? (zh ? '计数线端点' : 'Line point') : zh ? '区域顶点' : 'Region point'} ${i + 1}`}
              aria-valuetext={`${Math.round(p[0] * 100)}%, ${Math.round(p[1] * 100)}%`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={p[0] * 100}
              onPointerDown={(e) => {
                e.preventDefault()
                drag.current = i
                e.currentTarget.parentElement?.setPointerCapture(e.pointerId)
              }}
              onKeyDown={(e) => {
                const d: Record<string, Point> = {
                  ArrowLeft: [-0.01, 0],
                  ArrowRight: [0.01, 0],
                  ArrowUp: [0, -0.01],
                  ArrowDown: [0, 0.01],
                }
                if (d[e.key]) {
                  e.preventDefault()
                  update(i, [p[0] + d[e.key][0], p[1] + d[e.key][1]])
                }
              }}
            />
          ))}
        </svg>
      </Evidence>
      <p className="text-xs text-ink-3">
        {zh
          ? '先试运行获取画面，再拖动顶点；键盘方向键每次移动 1%。'
          : 'Run a preview to load a frame, then drag the handles. Arrow keys move by 1%.'}
      </p>
    </div>
  )
}

export function VisionInspection() {
  const zh = useLang((s) => s.lang) === 'zh',
    site = useSite((s) => s.siteId),
    admin = useCan('admin'),
    operator = useCan('operator')
  const confirm = useConfirm(),
    [data, setData] = useState<Data>(empty),
    [error, setError] = useState(''),
    [draft, setDraft] = useState<Config | null>(null),
    [busy, setBusy] = useState(false),
    [jobId, setJobId] = useState(''),
    [selected, setSelected] = useState<Result | null>(null),
    [overlay, setOverlay] = useState(true),
    [filter, setFilter] = useState(''),
    [assets, setAssets] = useState<{ id: string; name: string }[]>([])
  const endpoint = `/api/sites/${encodeURIComponent(site)}/vision`
  const request = useCallback(
    async (path = '', method = 'GET', body?: unknown) => {
      const res = await apiFetch(endpoint + path, {
        method,
        ...(body
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
      return json
    },
    [endpoint],
  )
  const refresh = useCallback(async () => {
    try {
      setData(await request())
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [request])
  useEffect(() => {
    let current = true
    const read = async () => {
      try {
        const d = await request()
        if (current) {
          setData(d)
          setError('')
        }
      } catch (e) {
        if (current) setError((e as Error).message)
      }
    }
    void read()
    const timer = setInterval(read, 2500)
    void apiFetch(`/api/sites/${encodeURIComponent(site)}/assets`)
      .then((r) => r.json())
      .then((d) => {
        if (current) setAssets(d.assets ?? d.items ?? [])
      })
      .catch(() => {})
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [request, site])
  const status = (s: string) =>
    ({
      normal: zh ? '正常' : 'Normal',
      alert: zh ? '告警' : 'Alert',
      unknown: zh ? '待观测' : 'Unknown',
      failed: zh ? '失败' : 'Failed',
      expired: zh ? '已超时' : 'Expired',
      queued: zh ? '试运行中' : 'Preview running',
      done: zh ? '试运行完成' : 'Preview complete',
    })[s] ?? s
  const mutate = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const currentJob = data.jobs.find((j) => j.id === jobId),
    preview = data.results.find((r) => r.id === currentJob?.resultId)
  const adapter = data.adapters.find((a) => a.id === draft?.adapterId),
    preset = data.presets.find((p) => p.id === draft?.preset)
  const change = (key: keyof Config, value: unknown) => {
    if (draft) setDraft({ ...draft, [key]: value })
  }
  const test = () =>
    draft &&
    mutate(async () => {
      const job = await request('/test', 'POST', draft)
      setJobId(job.id)
    })
  const close = () => {
    if (!busy) {
      setDraft(null)
      setJobId('')
    }
  }
  return (
    <div className="space-y-4" data-testid="vision-workspace">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-medium">{zh ? '视觉巡检' : 'Vision inspection'}</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-3">
            {zh
              ? '选择预置能力，设置检测区域，试运行后启用。连续监测需要固定视角。'
              : 'Choose a preset, define the region and preview before enabling. Continuous monitoring requires a fixed view.'}
          </p>
        </div>
        {admin && (
          <Button
            variant="signal"
            disabled={!data.adapters.some((a) => a.sources.length) || !data.presets.length}
            onClick={() => {
              setJobId('')
              setDraft(
                makeConfig(
                  data.presets[0],
                  data.adapters.find((a) => a.sources.length),
                ),
              )
            }}
          >
            <Plus size={16} />
            {zh ? '添加监测' : 'Add monitoring'}
          </Button>
        )}
      </div>
      {error && (
        <div role="alert" className="border border-line p-3 text-sm">
          {error}
          <Button variant="ghost" onClick={refresh}>
            <RefreshCw size={14} />
            {zh ? '重试' : 'Retry'}
          </Button>
        </div>
      )}
      {!data.adapters.length ? (
        <EmptyNote>
          {zh
            ? '尚未连接视觉 Adapter。在 Adapter 的配置文件中添加视频源并启动，连接后即可配置监测。'
            : 'No vision adapter is connected. Add video sources to your adapter configuration and start it to begin.'}
        </EmptyNote>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.adapters.map((a) => (
            <Panel key={a.id} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{a.name}</span>
                <Badge>{a.online ? (zh ? '在线' : 'Online') : zh ? '离线' : 'Offline'}</Badge>
              </div>
              <p className="mt-1 text-xs text-ink-3">
                {a.sources.length} {zh ? '个视频源' : 'sources'} · {a.models.detector} · {a.models.ocr}
              </p>
              {a.sources.map((s) => (
                <div key={s.id} className="mt-2 flex justify-between gap-3 text-sm">
                  <span>{s.label}</span>
                  <span className="text-ink-3" title={s.note}>
                    {!a.online
                      ? zh
                        ? '离线'
                        : 'Offline'
                      : s.status === 'ready'
                        ? zh
                          ? '画面稳定'
                          : 'Stable view'
                        : s.status === 'paused'
                          ? zh
                            ? '等待稳定画面'
                            : 'Waiting for stable view'
                          : zh
                            ? '等待视频'
                            : 'Waiting for video'}
                  </span>
                </div>
              ))}
            </Panel>
          ))}
        </div>
      )}
      <Panel>
        <PanelHead label={zh ? '监测配置' : 'Monitoring'} />
        {!data.configs.length ? (
          <EmptyNote>
            {zh
              ? '暂无监测配置。添加监测后可先试运行，确认画面和阈值再启用。'
              : 'No monitoring is configured. Add a rule and preview the scene and thresholds before enabling it.'}
          </EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{zh ? '名称 / 预置能力' : 'Name / preset'}</TableHead>
                  <TableHead>{zh ? '视频源' : 'Source'}</TableHead>
                  <TableHead>{zh ? '最新结果' : 'Latest result'}</TableHead>
                  <TableHead>{zh ? '启用' : 'Enabled'}</TableHead>
                  <TableHead className="text-right">{zh ? '操作' : 'Actions'}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.configs.map((c) => {
                  const a = data.adapters.find((a) => a.id === c.adapterId),
                    p = data.presets.find((p) => p.id === c.preset),
                    r = data.results.find(
                      (r) => !r.jobId && r.config.id === c.id && r.config.revision === c.revision,
                    )
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div>{c.name}</div>
                        <div className="text-xs text-ink-3">{zh ? p?.zh : p?.en}</div>
                      </TableCell>
                      <TableCell>
                        {a?.sources.find((s) => s.id === c.sourceId)?.label ?? c.sourceId}
                      </TableCell>
                      <TableCell>
                        {!c.enabled ? (
                          zh ? (
                            '已停用'
                          ) : (
                            'Disabled'
                          )
                        ) : !a?.online ? (
                          zh ? (
                            'Adapter 离线'
                          ) : (
                            'Adapter offline'
                          )
                        ) : r ? (
                          <Button variant="ghost" size="sm" onClick={() => setSelected(r)}>
                            {status(r.status)}
                            {r.value !== null ? ` · ${r.value} ${c.unit}` : ''}
                          </Button>
                        ) : zh ? (
                          '等待结果'
                        ) : (
                          'Awaiting result'
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={c.enabled}
                          aria-label={`${zh ? '启用' : 'Enable'} ${c.name}`}
                          disabled={!admin || busy}
                          onCheckedChange={(v) =>
                            mutate(() =>
                              request(`/configs/${c.id}`, 'PUT', {
                                ...c,
                                enabled: v,
                              }),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {operator && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`${zh ? '配置' : 'Configure'} ${c.name}`}
                              onClick={() => {
                                setJobId('')
                                setDraft(structuredClone(c))
                              }}
                            >
                              <Pencil size={15} />
                            </Button>
                          )}
                          {admin && (
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy}
                              aria-label={`${zh ? '删除' : 'Delete'} ${c.name}`}
                              onClick={async () => {
                                if (
                                  await confirm({
                                    title: zh ? '删除监测？' : 'Delete monitoring?',
                                    message: zh
                                      ? '历史结果和证据将保留至保留期结束。'
                                      : 'Historical results and evidence remain until retention expires.',
                                    destructive: true,
                                  })
                                )
                                  void mutate(() => request(`/configs/${c.id}`, 'DELETE'))
                              }}
                            >
                              <Trash2 size={15} />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
      <Panel>
        <PanelHead
          label={zh ? '观测记录' : 'Observations'}
          right={
            <Input
              aria-label={zh ? '搜索观测' : 'Search observations'}
              placeholder={zh ? '搜索名称或结果' : 'Search name or result'}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-56"
            />
          }
        />
        <p className="px-4 pb-2 text-xs text-ink-3">
          {zh
            ? '最近 200 条，保留 7 天。试运行不产生正式告警；延迟结果仅归档。'
            : 'Latest 200 observations, retained for 7 days. Previews do not raise alarms; delayed results are archived only.'}
        </p>
        {!data.results.length ? (
          <EmptyNote>{zh ? '暂无观测结果。' : 'No observations yet.'}</EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{zh ? '采集时间' : 'Captured'}</TableHead>
                  <TableHead>{zh ? '监测' : 'Monitoring'}</TableHead>
                  <TableHead>{zh ? '结果' : 'Result'}</TableHead>
                  <TableHead>{zh ? '读数' : 'Reading'}</TableHead>
                  <TableHead>{zh ? '证据' : 'Evidence'}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.results
                  .filter((r) =>
                    `${r.config.name} ${r.text} ${r.status}`.toLowerCase().includes(filter.toLowerCase()),
                  )
                  .map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="mono whitespace-nowrap">
                        {new Date(r.capturedAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {r.config.name}
                        {r.jobId && (
                          <span className="ml-2 text-xs text-ink-3">{zh ? '试运行' : 'Preview'}</span>
                        )}
                        {r.late && <span className="ml-2 text-xs text-ink-3">{zh ? '延迟' : 'Delayed'}</span>}
                      </TableCell>
                      <TableCell>
                        <Badge>{status(r.status)}</Badge>
                      </TableCell>
                      <TableCell className="max-w-48 truncate mono">
                        {r.value !== null ? `${r.value} ${r.config.unit}` : r.text || '—'}
                      </TableCell>
                      <TableCell>
                        <Button variant="outline" size="sm" onClick={() => setSelected(r)}>
                          {zh ? '查看' : 'Review'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
      {draft && (
        <Modal wide title={zh ? '监测配置' : 'Configure monitoring'} onClose={close}>
          <form
            className="max-h-[85dvh] overflow-y-auto space-y-4 p-1"
            onSubmit={(e) => {
              e.preventDefault()
              if (admin)
                void mutate(async () => {
                  await request(
                    draft.id ? `/configs/${draft.id}` : '/configs',
                    draft.id ? 'PUT' : 'POST',
                    draft,
                  )
                  setDraft(null)
                  setJobId('')
                })
            }}
          >
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-medium">{zh ? '监测配置' : 'Configure monitoring'}</h3>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={zh ? '关闭' : 'Close'}
                disabled={busy}
                onClick={close}
              >
                <X size={16} />
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={zh ? '名称' : 'Name'}>
                <Input
                  required
                  maxLength={120}
                  value={draft.name}
                  onChange={(e) => change('name', e.target.value)}
                />
              </Field>
              <Choice
                label={zh ? '预置能力' : 'Preset'}
                value={draft.preset}
                options={data.presets.map((p) => ({
                  value: p.id,
                  label: zh ? p.zh : p.en,
                }))}
                onChange={(v) => {
                  const p = data.presets.find((p) => p.id === v)!
                  const defaults = makeConfig(p, adapter)
                  setDraft({
                    ...draft,
                    preset: v,
                    durationS: defaults.durationS,
                    threshold: defaults.threshold,
                  })
                  setJobId('')
                }}
              />
              <Choice
                label="Adapter"
                value={draft.adapterId}
                options={data.adapters.map((a) => ({
                  value: a.id,
                  label: a.name,
                }))}
                onChange={(v) => {
                  setDraft({
                    ...draft,
                    adapterId: v,
                    sourceId: data.adapters.find((a) => a.id === v)?.sources[0]?.id ?? '',
                  })
                  setJobId('')
                }}
              />
              <Choice
                label={zh ? '视频源' : 'Video source'}
                value={draft.sourceId}
                options={(adapter?.sources ?? []).map((s) => ({
                  value: s.id,
                  label: `${s.label}${s.view === 'mobile' ? (zh ? '（移动视角，仅 OCR）' : ' (mobile, OCR only)') : ''}`,
                }))}
                onChange={(v) => {
                  change('sourceId', v)
                  setJobId('')
                }}
              />
            </div>
            <Geometry config={draft} set={setDraft} result={preview} zh={zh} />
            <div className="grid grid-cols-2 gap-3">
              {['above', 'below'].includes(preset?.rule ?? '') && (
                <Field
                  label={
                    preset?.rule === 'below'
                      ? zh
                        ? '人数少于'
                        : 'Occupancy below'
                      : zh
                        ? '人数超过'
                        : 'Occupancy above'
                  }
                >
                  <Input
                    type="number"
                    min={0}
                    max={10000}
                    value={draft.threshold}
                    onChange={(e) => change('threshold', e.target.valueAsNumber)}
                  />
                </Field>
              )}
              {preset?.rule !== 'ocr' && preset?.rule !== 'count' && preset?.rule !== 'cross' && (
                <Field label={zh ? '持续时间（秒）' : 'Duration (seconds)'}>
                  <Input
                    type="number"
                    min={0}
                    max={86400}
                    value={draft.durationS}
                    onChange={(e) => change('durationS', e.target.valueAsNumber)}
                  />
                </Field>
              )}
              {preset?.rule === 'cross' && (
                <Choice
                  label={zh ? '计数方向' : 'Crossing direction'}
                  value={draft.direction}
                  options={[
                    { value: 'both', label: zh ? '双向' : 'Both' },
                    {
                      value: 'forward',
                      label: zh ? '右侧到左侧（沿线方向）' : 'Right to left of directed line',
                    },
                    {
                      value: 'reverse',
                      label: zh ? '左侧到右侧（沿线方向）' : 'Left to right of directed line',
                    },
                  ]}
                  onChange={(v) => change('direction', v)}
                />
              )}
              <Field label={zh ? '置信度下限' : 'Minimum confidence'}>
                <Input
                  type="number"
                  min={0.1}
                  max={0.99}
                  step={0.05}
                  value={draft.confidence}
                  onChange={(e) => change('confidence', e.target.valueAsNumber)}
                />
              </Field>
              <Field label={zh ? '归档间隔（秒）' : 'Archive interval (seconds)'}>
                <Input
                  type="number"
                  min={1}
                  max={3600}
                  value={draft.intervalS}
                  onChange={(e) => change('intervalS', e.target.valueAsNumber)}
                />
              </Field>
              <Choice
                label={zh ? '告警等级' : 'Alarm severity'}
                value={draft.severity}
                options={['info', 'low', 'high', 'critical'].map((value) => ({
                  value,
                  label:
                    (
                      {
                        info: '信息',
                        low: '低',
                        high: '高',
                        critical: '紧急',
                      } as Record<string, string>
                    )[value] && zh
                      ? (
                          {
                            info: '信息',
                            low: '低',
                            high: '高',
                            critical: '紧急',
                          } as Record<string, string>
                        )[value]
                      : value,
                }))}
                onChange={(v) => change('severity', v)}
              />
              <Choice
                label={zh ? '关联设备' : 'Associated asset'}
                value={draft.assetId}
                options={[
                  { value: '', label: zh ? '无' : 'None' },
                  ...assets.map((a) => ({ value: a.id, label: a.name })),
                ]}
                onChange={(v) => change('assetId', v)}
              />
            </div>
            {preset?.engine === 'ocr' && (
              <div className="space-y-3 border border-line p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">{zh ? '读取单个数值' : 'Read one numeric value'}</span>
                  <Switch
                    aria-label={zh ? '读取单个数值' : 'Read one numeric value'}
                    checked={draft.numeric}
                    onCheckedChange={(v) => change('numeric', v)}
                  />
                </div>
                {draft.numeric && (
                  <div className="grid grid-cols-3 gap-3">
                    <Field label={zh ? '单位' : 'Unit'}>
                      <Input
                        maxLength={24}
                        value={draft.unit}
                        onChange={(e) => change('unit', e.target.value)}
                      />
                    </Field>
                    {(['min', 'max'] as const).map((key) => (
                      <Field
                        key={key}
                        label={
                          key === 'min'
                            ? zh
                              ? '下限（可选）'
                              : 'Min (optional)'
                            : zh
                              ? '上限（可选）'
                              : 'Max (optional)'
                        }
                      >
                        <Input
                          type="number"
                          step="any"
                          value={draft[key] ?? ''}
                          onChange={(e) => change(key, e.target.value === '' ? null : e.target.valueAsNumber)}
                        />
                      </Field>
                    ))}
                  </div>
                )}
                <p className="text-xs text-ink-3">
                  {zh
                    ? '将区域收紧至单个显示值。多值、低置信度或无法识别的读数会记为待观测。'
                    : 'Crop to one display value. Ambiguous, low-confidence or unreadable text is recorded as unknown.'}
                </p>
              </div>
            )}
            <div className="space-y-3 border border-line p-3">
              <div className="flex items-center justify-between text-sm">
                <span>{zh ? '按时段监测（UTC）' : 'Scheduled monitoring (UTC)'}</span>
                <Switch
                  aria-label={zh ? '按时段监测' : 'Scheduled monitoring'}
                  checked={!!draft.schedule}
                  onCheckedChange={(v) =>
                    change(
                      'schedule',
                      v
                        ? {
                            days: [1, 2, 3, 4, 5],
                            start: '09:00',
                            end: '17:00',
                          }
                        : null,
                    )
                  }
                />
              </div>
              {draft.schedule && (
                <>
                  <div className="flex flex-wrap gap-1">
                    {(zh
                      ? ['日', '一', '二', '三', '四', '五', '六']
                      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
                    ).map((d, i) => (
                      <Button
                        key={i}
                        type="button"
                        size="sm"
                        variant={draft.schedule!.days.includes(i) ? 'utility' : 'outline'}
                        aria-pressed={draft.schedule!.days.includes(i)}
                        onClick={() =>
                          change('schedule', {
                            ...draft.schedule,
                            days: draft.schedule!.days.includes(i)
                              ? draft.schedule!.days.filter((n) => n !== i)
                              : [...draft.schedule!.days, i],
                          })
                        }
                      >
                        {d}
                      </Button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {(['start', 'end'] as const).map((key) => (
                      <Field
                        key={key}
                        label={
                          key === 'start'
                            ? zh
                              ? '开始（UTC）'
                              : 'Start (UTC)'
                            : zh
                              ? '结束（UTC）'
                              : 'End (UTC)'
                        }
                      >
                        <Input
                          type="time"
                          required
                          value={draft.schedule![key]}
                          onChange={(e) =>
                            change('schedule', {
                              ...draft.schedule,
                              [key]: e.target.value,
                            })
                          }
                        />
                      </Field>
                    ))}
                  </div>
                  <p className="text-xs text-ink-3">
                    {zh
                      ? '支持跨午夜；开始和结束相同表示全天。'
                      : 'Overnight periods are supported; equal start and end means all day.'}
                  </p>
                </>
              )}
            </div>
            <div className="border border-line p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !adapter?.online || !draft.name.trim() || currentJob?.status === 'queued'}
                  onClick={test}
                >
                  <Play size={14} />
                  {zh ? '试运行' : 'Run preview'}
                </Button>
                <span className="text-sm" role="status">
                  {currentJob
                    ? status(currentJob.status)
                    : zh
                      ? '试运行最多 40 秒，不产生告警'
                      : 'Preview runs up to 40 seconds without raising alarms'}
                </span>
              </div>
              {preview && (
                <p className="text-sm">
                  {status(preview.status)} · {preview.value ?? (preview.text || '—')}
                  <br />
                  <span className="text-xs text-ink-3">{preview.note}</span>
                </p>
              )}
            </div>
            <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-line bg-bg py-3">
              <div className="flex items-center gap-2 text-sm">
                <Switch
                  aria-label={zh ? '保存后启用' : 'Enable after saving'}
                  checked={draft.enabled}
                  disabled={!admin}
                  onCheckedChange={(v) => change('enabled', v)}
                />
                {zh ? '启用监测' : 'Enable monitoring'}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={close}>
                  {zh ? '取消' : 'Cancel'}
                </Button>
                {admin && (
                  <Button
                    type="submit"
                    variant="signal"
                    disabled={busy || !draft.adapterId || !draft.sourceId}
                  >
                    {zh ? '保存' : 'Save'}
                  </Button>
                )}
              </div>
            </div>
          </form>
        </Modal>
      )}
      {selected && (
        <Modal wide title={zh ? '观测详情' : 'Observation details'} onClose={() => setSelected(null)}>
          <div className="max-h-[85dvh] overflow-y-auto space-y-3">
            <div className="flex justify-between items-center">
              <h3 className="text-lg">{selected.config.name}</h3>
              <Button
                variant="ghost"
                size="icon"
                aria-label={zh ? '关闭' : 'Close'}
                onClick={() => setSelected(null)}
              >
                <X size={16} />
              </Button>
            </div>
            <Evidence result={selected} overlay={overlay} />
            <div className="flex items-center justify-between">
              <Badge>{status(selected.status)}</Badge>
              <div className="flex items-center gap-2 text-sm">
                <Switch
                  aria-label={zh ? '显示标注' : 'Show annotations'}
                  checked={overlay}
                  onCheckedChange={setOverlay}
                />
                {zh ? '显示标注' : 'Show annotations'}
              </div>
            </div>
            <p>
              {selected.value !== null ? `${selected.value} ${selected.config.unit}` : selected.text || '—'}
            </p>
            <p className="text-sm text-ink-3">{selected.note}</p>
            <p className="text-xs mono text-ink-3">
              {new Date(selected.capturedAt).toLocaleString()} · {selected.model} · rev{' '}
              {selected.config.revision}
            </p>
            {selected.evidence && (
              <a
                href={selected.evidence}
                download={`vision-${selected.id}.jpg`}
                className="inline-flex text-sm underline"
              >
                {zh ? '下载原图' : 'Download original'}
              </a>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
