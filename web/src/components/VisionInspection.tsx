import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Add as Plus,
  Edit as Pencil,
  TrashCan as Trash2,
  Close as X,
  Play,
  Renew as RefreshCw,
} from '@carbon/icons-react'
import { toast } from 'sonner'
import { apiFetch, useCan, useSite } from '../lib/store'
import { useLang } from '../lib/i18n'
import { EmptyNote, Modal } from './ui'
import { useConfirm } from './ConfirmDialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { Badge } from './ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

import {
  monitoringRequest,
  confidenceText,
  type Point,
  type VisionConfig as Config,
  type VisionPreset as Preset,
  type VisionAdapter as Adapter,
  type VisionResult as Result,
  type VisionData as Data,
} from '../lib/monitoring'

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
export function RuleField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm text-ink-2">
      {label}
      {children}
    </label>
  )
}
export function RuleChoice({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <RuleField label={label}>
      <Select disabled={disabled} value={value || '_'} onValueChange={(v) => onChange(v === '_' ? '' : v)}>
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
    </RuleField>
  )
}

export function VisionEvidence({
  result,
  children,
  overlay = true,
}: {
  result?: Result
  children?: ReactNode
  overlay?: boolean
}) {
  const zh = useLang((s) => s.lang) === 'zh'
  const [broken, setBroken] = useState('')
  const imageAvailable = !!result?.evidence && !result.evidenceExpired && broken !== result.evidence
  return (
    <div className="relative overflow-hidden border border-line bg-bg-2">
      {imageAvailable && result ? (
        <img
          src={result.evidence}
          alt={result.config.name}
          onError={() => setBroken(result.evidence)}
          className="block w-full"
        />
      ) : (
        <div className="aspect-video flex items-center justify-center p-5 text-center text-sm text-ink-3">
          {children
            ? ''
            : result?.evidenceExpired
              ? zh
                ? '原图已过保留期'
                : 'Original image has expired'
              : zh
                ? '暂无可用原图'
                : 'No original image available'}
        </div>
      )}
      {imageAvailable && result && overlay && (
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
                stroke="#111"
                strokeWidth="3"
                paintOrder="stroke"
              >
                {a.label} {confidenceText(a.score, zh)}
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
  const hasLine = ['line_crossing', 'vehicle_count'].includes(config.preset)
  const line = hasLine && mode === 'line',
    points = line ? config.line : config.region
  const update = (i: number, p: Point) =>
    set({
      ...config,
      [mode]: points.map((v, j) => (j === i ? p.map((n) => Math.max(0, Math.min(1, n))) : v)),
    })
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          {hasLine
            ? zh
              ? '检测区域与计数线'
              : 'Region & counting line'
            : zh
              ? '检测区域'
              : 'Detection region'}
        </span>
        <div className="flex gap-2">
          {hasLine && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setMode(line ? 'region' : 'line')}
            >
              {line ? (zh ? '编辑区域' : 'Edit region') : zh ? '编辑计数线' : 'Edit line'}
            </Button>
          )}
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
      <VisionEvidence result={result} overlay={false}>
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
          {hasLine && (
            <line
              x1={config.line[0][0] * 1000}
              y1={config.line[0][1] * 1000}
              x2={config.line[1][0] * 1000}
              y2={config.line[1][1] * 1000}
              stroke="#6bc5ff"
              strokeWidth="4"
            />
          )}
        </svg>
        {points.map((p, i) => (
          <Button
            type="button"
            variant="outline"
            key={`${mode}-${i}`}
            className="absolute z-10 h-8 w-8 min-w-8 touch-none p-0 text-xs"
            style={{
              left: `clamp(16px, ${p[0] * 100}%, calc(100% - 16px))`,
              top: `clamp(16px, ${p[1] * 100}%, calc(100% - 16px))`,
              transform: 'translate(-50%, -50%)',
              borderColor: line ? '#359bd6' : '#956000',
            }}
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
              e.currentTarget.setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              if (drag.current !== i) return
              const b = e.currentTarget.parentElement!.getBoundingClientRect()
              update(i, [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height])
            }}
            onPointerUp={() => {
              drag.current = null
            }}
            onPointerCancel={() => {
              drag.current = null
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
          >
            {i + 1}
          </Button>
        ))}
        {hasLine &&
          ['A', 'B'].map((label, i) => {
            const a = config.line[0],
              b = config.line[1],
              dx = b[0] - a[0],
              dy = b[1] - a[1],
              length = Math.hypot(dx, dy) || 1,
              sign = i === 0 ? 1 : -1
            return (
              <span
                key={label}
                className="pointer-events-none absolute bg-bg px-1 text-xs font-medium"
                style={{
                  left: `${Math.max(3, Math.min(97, (a[0] + b[0]) / 2 + ((sign * dy) / length) * 0.08)) * 100}%`,
                  top: `${Math.max(3, Math.min(97, (a[1] + b[1]) / 2 - ((sign * dx) / length) * 0.08)) * 100}%`,
                  transform: 'translate(-50%, -50%)',
                }}
              >
                {label}
              </span>
            )
          })}
      </VisionEvidence>
      <p className="text-xs text-ink-3">
        {zh
          ? '先试运行获取画面，再拖动顶点；键盘方向键每次移动 1%。'
          : 'Run a preview to load a frame, then drag the handles. Arrow keys move by 1%.'}
      </p>
    </div>
  )
}

export function VisionRuleForm({
  initial,
  channelId,
  onSaved,
  onClose,
}: {
  initial?: Config
  channelId?: string
  onSaved: () => void
  onClose: () => void
}) {
  const zh = useLang((s) => s.lang) === 'zh'
  const site = useSite((s) => s.siteId),
    admin = useCan('admin'),
    operator = useCan('operator')
  const [data, setData] = useState<Data>(empty),
    [draft, setDraft] = useState<Config | null>(initial ? structuredClone(initial) : null)
  const [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [jobId, setJobId] = useState('')
  const [assets, setAssets] = useState<{ id: string; name: string }[]>([])
  const request = useCallback(
    (path = '', method = 'GET', body?: unknown) =>
      monitoringRequest<any>(site, `/vision${path}`, method, body),
    [site],
  )
  const refresh = useCallback(async () => {
    const next = await request()
    setData(next)
    setLoaded(true)
    setError('')
  }, [request])
  useEffect(() => {
    let current = true,
      timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const next = await request()
        if (current) {
          setData(next)
          setLoaded(true)
          setError('')
        }
      } catch (e) {
        if (current) {
          setError((e as Error).message)
          setLoaded(true)
        }
      }
      if (current) timer = setTimeout(read, 2500)
    }
    void read()
    void monitoringRequest<{ assets?: { id: string; name: string }[] }>(site, '/assets')
      .then((d) => {
        if (current) setAssets(d.assets ?? [])
      })
      .catch(() => {})
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [request, site])
  useEffect(() => {
    if (draft || !data.presets.length) return
    const linkedAdapter = channelId
      ? data.adapters.find((a) => a.sources.some((s) => s.channelId === channelId))
      : data.adapters.find((a) => a.sources.length)
    const linkedSource = channelId
      ? linkedAdapter?.sources.find((s) => s.channelId === channelId)
      : linkedAdapter?.sources[0]
    const firstPreset = data.presets.find(
      (p) =>
        (!linkedAdapter?.capabilities || linkedAdapter.capabilities.presets.includes(p.id)) &&
        (linkedSource?.view !== 'mobile' || p.engine === 'ocr'),
    )
    const next = makeConfig(firstPreset ?? data.presets[0], linkedAdapter)
    if (!firstPreset) next.preset = ''
    if (channelId) next.sourceId = linkedAdapter?.sources.find((s) => s.channelId === channelId)?.id ?? ''
    setDraft(next)
  }, [data, draft, channelId])
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
  const source = adapter?.sources.find((s) => s.id === draft?.sourceId)
  const availablePresets = data.presets.filter(
    (p) =>
      (!adapter?.capabilities || adapter.capabilities.presets.includes(p.id)) &&
      (source?.view !== 'mobile' || p.engine === 'ocr'),
  )
  const presetAvailable = availablePresets.some((p) => p.id === draft?.preset)
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
    if (!busy) onClose()
  }
  const status = (s: string) => observationStatus(s, zh)
  return (
    <div className="space-y-4" data-testid="vision-rule-form">
      <p className="text-sm text-ink-3">
        {zh
          ? '选择已连接的视频源和真实预置能力，设置区域后试运行。试运行不创建事件。'
          : 'Choose a connected source and supported preset, set the region, then preview. Previews do not create events.'}
      </p>
      {channelId &&
        !data.adapters.some((a) => a.sources.some((s) => s.channelId === channelId)) &&
        loaded && (
          <p className="rounded-md border border-line p-3 text-sm text-ink-2">
            {zh
              ? '该摄像头未关联视觉 Adapter 视频源。请明确选择已注册源；平台不会自动绑定其他画面。'
              : 'This camera has no linked vision adapter source. Select a registered source explicitly; another view will not be linked automatically.'}
          </p>
        )}
      {error && (
        <div role="alert" className="text-sm text-crit">
          {error}
          <Button variant="ghost" onClick={() => void refresh().catch((e) => setError(e.message))}>
            {zh ? '重试' : 'Retry'}
          </Button>
        </div>
      )}
      {!loaded && (
        <div role="status" className="text-sm text-ink-3">
          {zh ? '加载视频源…' : 'Loading video sources…'}
        </div>
      )}
      {loaded && !data.adapters.some((a) => a.sources.length) && (
        <EmptyNote>
          {zh
            ? '尚无已注册视觉视频源。先在集成层连接视觉 Adapter，再配置视觉规则。'
            : 'No vision source is registered. Connect a vision adapter before configuring a visual rule.'}
        </EmptyNote>
      )}
      {draft && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (admin)
              void mutate(async () => {
                await request(
                  draft.id ? `/configs/${draft.id}` : '/configs',
                  draft.id ? 'PUT' : 'POST',
                  draft,
                )
                onSaved()
              })
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <RuleField label={zh ? '名称' : 'Name'}>
              <Input
                required
                maxLength={120}
                value={draft.name}
                onChange={(e) => change('name', e.target.value)}
              />
            </RuleField>
            <RuleChoice
              label={zh ? '预置能力' : 'Preset'}
              value={draft.preset}
              options={availablePresets.map((p) => ({
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
            <RuleChoice
              label="Adapter"
              value={draft.adapterId}
              options={[
                { value: '', label: zh ? '选择 Adapter' : 'Select adapter' },
                ...data.adapters.map((a) => ({
                  value: a.id,
                  label: a.name,
                })),
              ]}
              onChange={(v) => {
                setDraft({
                  ...draft,
                  adapterId: v,
                  sourceId: data.adapters.find((a) => a.id === v)?.sources[0]?.id ?? '',
                })
                setJobId('')
              }}
            />
            <RuleChoice
              label={zh ? '视频源' : 'Video source'}
              value={draft.sourceId}
              options={[
                { value: '', label: zh ? '选择视频源' : 'Select video source' },
                ...(adapter?.sources ?? []).map((s) => ({
                  value: s.id,
                  label: `${s.label}${s.view === 'mobile' ? (zh ? '（移动视角，仅 OCR）' : ' (mobile, OCR only)') : ''}`,
                })),
              ]}
              onChange={(v) => {
                change('sourceId', v)
                setJobId('')
              }}
            />
          </div>
          {!presetAvailable && (
            <p role="status" className="text-sm text-ink-2">
              {zh
                ? '请选择该来源支持的预置能力；移动视角仅支持 OCR。'
                : 'Choose a preset supported by this source; mobile views support OCR only.'}
            </p>
          )}
          <Geometry config={draft} set={setDraft} result={preview} zh={zh} />
          <div className="grid grid-cols-2 gap-3">
            {['above', 'below'].includes(preset?.rule ?? '') && (
              <RuleField
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
              </RuleField>
            )}
            {preset?.rule !== 'ocr' && preset?.rule !== 'count' && preset?.rule !== 'cross' && (
              <RuleField label={zh ? '持续时间（秒）' : 'Duration (seconds)'}>
                <Input
                  type="number"
                  min={0}
                  max={86400}
                  value={draft.durationS}
                  onChange={(e) => change('durationS', e.target.valueAsNumber)}
                />
              </RuleField>
            )}
            {preset?.rule === 'cross' && (
              <RuleChoice
                label={zh ? '计数方向' : 'Crossing direction'}
                value={draft.direction}
                options={[
                  { value: 'both', label: zh ? '双向' : 'Both' },
                  {
                    value: 'forward',
                    label: 'A → B',
                  },
                  {
                    value: 'reverse',
                    label: 'B → A',
                  },
                ]}
                onChange={(v) => change('direction', v)}
              />
            )}
            <RuleField label={zh ? '置信度下限' : 'Minimum confidence'}>
              <Input
                type="number"
                min={0.1}
                max={0.99}
                step={0.05}
                value={draft.confidence}
                onChange={(e) => change('confidence', e.target.valueAsNumber)}
              />
            </RuleField>
            <RuleField label={zh ? '归档间隔（秒）' : 'Archive interval (seconds)'}>
              <Input
                type="number"
                min={1}
                max={3600}
                value={draft.intervalS}
                onChange={(e) => change('intervalS', e.target.valueAsNumber)}
              />
            </RuleField>
            <RuleChoice
              label={zh ? '告警等级' : 'Alarm severity'}
              value={draft.severity}
              options={['info', 'low', 'high', 'critical'].map((value) => ({
                value,
                label: zh
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
            <RuleChoice
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
                  <RuleField label={zh ? '单位' : 'Unit'}>
                    <Input
                      maxLength={24}
                      value={draft.unit}
                      onChange={(e) => change('unit', e.target.value)}
                    />
                  </RuleField>
                  {(['min', 'max'] as const).map((key) => (
                    <RuleField
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
                    </RuleField>
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
                    <RuleField
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
                    </RuleField>
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
                disabled={
                  !operator ||
                  busy ||
                  !presetAvailable ||
                  !adapter?.online ||
                  !draft.sourceId ||
                  !draft.name.trim() ||
                  currentJob?.status === 'queued'
                }
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface pt-3">
            <div className="flex items-center gap-2 text-sm">
              <Switch
                aria-label={zh ? '保存后启用' : 'Enable after saving'}
                checked={draft.enabled}
                disabled={!admin}
                onCheckedChange={(v) => change('enabled', v)}
              />
              {zh ? '启用规则' : 'Enable rule'}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={close}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              {admin && (
                <Button
                  type="submit"
                  variant="signal"
                  disabled={busy || !presetAvailable || !draft.adapterId || !draft.sourceId}
                >
                  {zh ? '保存规则' : 'Save rule'}
                </Button>
              )}
            </div>
          </div>
        </form>
      )}
    </div>
  )
}

export function observationStatus(value: string, zh: boolean) {
  return (
    (
      {
        normal: zh ? '正常' : 'Normal',
        alert: zh ? '触发' : 'Triggered',
        unknown: zh ? '未知' : 'Unknown',
        failed: zh ? '失败' : 'Failed',
        expired: zh ? '已超时' : 'Expired',
        queued: zh ? '试运行中' : 'Preview running',
        done: zh ? '试运行完成' : 'Preview complete',
      } as Record<string, string>
    )[value] ?? value
  )
}

export function VisionObservationDialog({ result, onClose }: { result: Result; onClose: () => void }) {
  const zh = useLang((s) => s.lang) === 'zh',
    [overlay, setOverlay] = useState(true)
  return (
    <Modal wide title={zh ? '观测详情' : 'Observation details'} onClose={onClose}>
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-lg font-medium">{result.config.name}</h3>
          <Button variant="ghost" size="icon" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}>
            <X size={16} />
          </Button>
        </div>
        <VisionEvidence result={result} overlay={overlay} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge>{observationStatus(result.status, zh)}</Badge>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              aria-label={zh ? '显示标注' : 'Show annotations'}
              checked={overlay}
              onCheckedChange={setOverlay}
            />
            {zh ? '显示标注' : 'Show annotations'}
          </label>
        </div>
        <p className="mono">
          {result.value !== null ? `${result.value} ${result.config.unit}` : result.text || '—'}
        </p>
        <p className="text-sm text-ink-2">{result.note}</p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-3">{zh ? '模型置信度' : 'Model confidence'}</dt>
            <dd>{confidenceText(result.confidence, zh)}</dd>
          </div>
          <div>
            <dt className="text-ink-3">{zh ? '模型 / 版本' : 'Model / revision'}</dt>
            <dd className="break-words">
              {result.model || (zh ? '未知' : 'Unknown')} · {result.config.revision ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">{zh ? '采集时间' : 'Captured'}</dt>
            <dd>{new Date(result.capturedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-ink-3">{zh ? '用途' : 'Purpose'}</dt>
            <dd>
              {result.jobId
                ? zh
                  ? '试运行，不创建事件'
                  : 'Preview, no event created'
                : result.late
                  ? zh
                    ? '延迟观测，仅归档'
                    : 'Delayed observation, archived only'
                  : zh
                    ? '正式监测'
                    : 'Monitoring'}
            </dd>
          </div>
        </dl>
        {result.evidence && (
          <a href={result.evidence} download={`vision-${result.id}.jpg`} className="text-link">
            {zh ? '下载原图' : 'Download original'}
          </a>
        )}
      </div>
    </Modal>
  )
}
