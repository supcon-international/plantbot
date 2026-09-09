import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Add, Close, Edit, TrashCan, Renew, Video } from '@carbon/icons-react'
import { toast } from 'sonner'
import { useApp, useCan, useSite } from '../lib/store'
import { useLang } from '../lib/i18n'
import {
  monitoringRequest,
  type MonitoringData,
  type MonitoringRule,
  type VisionConfig,
  type VisionData,
  type VisionResult,
} from '../lib/monitoring'
import type { DetectionRule, Reading } from '../lib/types'
import { EmptyNote, Modal, Panel, SevTag } from './ui'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Switch } from './ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { useConfirm } from './ConfirmDialog'
import {
  RuleField,
  RuleChoice,
  VisionRuleForm,
  VisionObservationDialog,
  observationStatus,
} from './VisionInspection'

const empty: MonitoringData = { rules: [], metrics: [], presets: [] }
export function useMonitoringData() {
  const site = useSite((s) => s.siteId)
  const [data, setData] = useState<MonitoringData>(empty),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false)
  const refresh = useCallback(async () => {
    const next = await monitoringRequest<MonitoringData>(site, '/monitoring-rules')
    setData(next)
    setError('')
    setLoaded(true)
  }, [site])
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>
    setData(empty)
    setLoaded(false)
    setError('')
    const read = async () => {
      try {
        const next = await monitoringRequest<MonitoringData>(site, '/monitoring-rules')
        if (active) {
          setData(next)
          setError('')
          setLoaded(true)
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message)
          setLoaded(true)
        }
      }
      if (active) timer = setTimeout(read, 5000)
    }
    void read()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [site])
  return { data, loaded, error, refresh }
}
const typeText = (type: MonitoringRule['type'], zh: boolean) =>
  ({
    vision: zh ? '视觉' : 'Visual',
    threshold: zh ? '指标阈值' : 'Metric threshold',
    sim: zh ? '演示模拟' : 'Demo simulation',
    external: zh ? '集成上报' : 'Integration',
  })[type]
const runtimeText = (status: MonitoringRule['runtime']['status'], zh: boolean) =>
  ({
    disabled: zh ? '已暂停' : 'Paused',
    offline: zh ? '来源离线' : 'Source offline',
    unavailable: zh ? '来源不可用' : 'Source unavailable',
    idle: zh ? '等待观测' : 'Awaiting observation',
    active: zh ? '监测中' : 'Monitoring',
    unknown: zh ? '状态未知' : 'Unknown',
  })[status]
function condition(rule: MonitoringRule, data: MonitoringData, zh: boolean) {
  if (rule.type === 'vision') {
    const c = rule.config as VisionConfig,
      preset = data.presets.find((p) => p.id === c.preset)
    return `${(zh ? preset?.zh : preset?.en) ?? c.preset}${c.numeric ? ` · ${c.min ?? '−∞'}…${c.max ?? '+∞'} ${c.unit}` : ['above', 'below'].includes(preset?.rule ?? '') ? ` · ${preset?.rule === 'above' ? '>' : '<'} ${c.threshold}` : ''}`
  }
  const c = rule.config as DetectionRule
  if (rule.type === 'threshold')
    return `${data.metrics.find((m) => m.id === c.metric)?.label ?? c.metric} ${c.op} ${c.bound} ${data.metrics.find((m) => m.id === c.metric)?.unit ?? ''}`
  return rule.type === 'sim'
    ? zh
      ? '仅演示数据，不代表模型能力'
      : 'Demo data, not a supported model'
    : zh
      ? '由外部集成产生'
      : 'Produced by an external integration'
}

export function MonitoringRuleEditor({
  rule,
  channelId,
  data,
  onClose,
  onSaved,
}: {
  rule?: MonitoringRule
  channelId?: string
  data: MonitoringData
  onClose: () => void
  onSaved: () => void
}) {
  const zh = useLang((s) => s.lang) === 'zh'
  const [kind, setKind] = useState<'vision' | 'threshold'>(
    rule?.type === 'threshold' ? 'threshold' : 'vision',
  )
  return (
    <Modal
      wide
      title={rule ? (zh ? '编辑规则' : 'Edit rule') : zh ? '新建规则' : 'New rule'}
      onClose={onClose}
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium">
            {rule ? (zh ? '编辑规则' : 'Edit rule') : zh ? '新建规则' : 'New rule'}
          </h2>
          <Button variant="ghost" size="icon" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}>
            <Close size={16} />
          </Button>
        </div>
        {rule ? (
          <Badge variant="outline">{typeText(rule.type, zh)}</Badge>
        ) : (
          <RuleChoice
            label={zh ? '规则类型' : 'Rule type'}
            value={kind}
            onChange={(v) => setKind(v as typeof kind)}
            options={[
              { value: 'vision', label: zh ? '视觉监测' : 'Visual monitoring' },
              {
                value: 'threshold',
                label: zh ? '指标阈值' : 'Metric threshold',
              },
            ]}
          />
        )}
        {kind === 'vision' ? (
          <VisionRuleForm
            initial={rule?.config as VisionConfig | undefined}
            channelId={channelId}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : (
          <ThresholdRuleForm
            initial={rule?.config as DetectionRule | undefined}
            data={data}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </div>
    </Modal>
  )
}
function ThresholdRuleForm({
  initial,
  data,
  onClose,
  onSaved,
}: {
  initial?: DetectionRule
  data: MonitoringData
  onClose: () => void
  onSaved: () => void
}) {
  const zh = useLang((s) => s.lang) === 'zh',
    site = useSite((s) => s.siteId),
    admin = useCan('admin')
  const robots = useApp((s) => s.robots)
  const [name, setName] = useState(initial?.name ?? ''),
    [robotId, setRobot] = useState(initial?.robotId ?? ''),
    [metric, setMetric] = useState(initial?.metric ?? '')
  const [op, setOp] = useState(initial?.op ?? '>'),
    [bound, setBound] = useState(initial?.bound?.toString() ?? ''),
    [severity, setSeverity] = useState(initial?.severity ?? 'high'),
    [enabled, setEnabled] = useState(initial?.enabled ?? false),
    [busy, setBusy] = useState(false)
  const definition = data.metrics.find((m) => m.id === metric)
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!admin) return
        setBusy(true)
        try {
          await monitoringRequest(
            site,
            initial ? `/rules/${encodeURIComponent(initial.id)}` : '/rules',
            initial ? 'PATCH' : 'POST',
            initial
              ? {
                  name: name.trim(),
                  op,
                  bound: Number(bound),
                  severity,
                  enabled,
                }
              : {
                  kind: 'threshold',
                  name: name.trim(),
                  robotId,
                  metric,
                  op,
                  bound: Number(bound),
                  severity,
                  enabled,
                },
          )
          onSaved()
        } catch (e) {
          toast.error((e as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <p className="text-sm text-ink-3">
        {zh
          ? '使用机器人实际上报的指标读数。未上报或过期数据不会被当作正常。'
          : 'Evaluate metrics actually reported by the robot. Missing or stale readings are not treated as normal.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <RuleField label={zh ? '名称' : 'Name'}>
          <Input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </RuleField>
        <RuleChoice
          label={zh ? '机器人' : 'Robot'}
          disabled={!!initial}
          value={robotId}
          onChange={setRobot}
          options={[
            { value: '', label: zh ? '选择机器人' : 'Select robot' },
            ...robots.map((r) => ({ value: r.id, label: r.callsign })),
          ]}
        />
        <RuleChoice
          label={zh ? '指标' : 'Metric'}
          disabled={!!initial}
          value={metric}
          onChange={setMetric}
          options={[
            { value: '', label: zh ? '选择指标' : 'Select metric' },
            ...data.metrics.map((m) => ({
              value: m.id,
              label: `${m.label} · ${m.unit}`,
            })),
          ]}
        />
        <RuleChoice
          label={zh ? '触发条件' : 'Trigger condition'}
          value={op}
          onChange={(v) => setOp(v as '>' | '<')}
          options={[
            { value: '>', label: zh ? '高于 >' : 'Above >' },
            { value: '<', label: zh ? '低于 <' : 'Below <' },
          ]}
        />
        <RuleField label={`${zh ? '阈值' : 'Threshold'}${definition?.unit ? ` (${definition.unit})` : ''}`}>
          <Input required type="number" step="any" value={bound} onChange={(e) => setBound(e.target.value)} />
        </RuleField>
        <RuleChoice
          label={zh ? '告警等级' : 'Alarm severity'}
          value={severity}
          onChange={(v) => setSeverity(v as typeof severity)}
          options={['critical', 'high', 'low', 'info'].map((value) => ({
            value,
            label: zh
              ? (
                  {
                    critical: '紧急',
                    high: '高',
                    low: '低',
                    info: '信息',
                  } as Record<string, string>
                )[value]
              : value,
          }))}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={enabled}
            disabled={!admin}
            aria-label={zh ? '保存后启用' : 'Enable after saving'}
            onCheckedChange={setEnabled}
          />
          {zh ? '启用规则' : 'Enable rule'}
        </label>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {zh ? '取消' : 'Cancel'}
          </Button>
          {admin && (
            <Button
              type="submit"
              variant="signal"
              disabled={
                busy || !name.trim() || !robotId || !metric || bound === '' || !Number.isFinite(Number(bound))
              }
            >
              {zh ? '保存规则' : 'Save rule'}
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}

export function MonitoringRules({ onViewEvents }: { onViewEvents: (id: string) => void }) {
  const zh = useLang((s) => s.lang) === 'zh',
    site = useSite((s) => s.siteId),
    admin = useCan('admin'),
    operator = useCan('operator'),
    confirm = useConfirm()
  const { data, error, loaded, refresh } = useMonitoringData(),
    [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<MonitoringRule | true | null>(null),
    [busy, setBusy] = useState(false)
  const channelId = params.get('channel') ?? undefined,
    selected = data.rules.find((r) => r.id === params.get('rule'))
  const shown = channelId ? data.rules.filter((r) => r.channelId === channelId) : data.rules
  useEffect(() => {
    if (params.get('new') === '1' && admin) setEditing(true)
  }, [params, admin])
  const closeEditor = () => {
    setEditing(null)
    if (params.has('new')) {
      const next = new URLSearchParams(params)
      next.delete('new')
      setParams(next, { replace: true })
    }
  }
  const change = async (rule: MonitoringRule, enabled: boolean) => {
    setBusy(true)
    try {
      await monitoringRequest(
        site,
        rule.type === 'vision'
          ? `/vision/configs/${encodeURIComponent(rule.id)}`
          : `/rules/${encodeURIComponent(rule.id)}`,
        rule.type === 'vision' ? 'PUT' : 'PATCH',
        rule.type === 'vision' ? { ...rule.config, enabled } : { enabled },
      )
      await refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const select = (id?: string) => {
    const next = new URLSearchParams(params)
    next.set('view', 'rules')
    if (id) next.set('rule', id)
    else next.delete('rule')
    setParams(next, { replace: true })
  }
  return (
    <div className="space-y-3" data-testid="monitoring-rules">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">{zh ? '监测规则' : 'Monitoring rules'}</h2>
          <p className="mt-1 text-sm text-ink-3">
            {zh
              ? '视觉与指标监测统一管理；启用设置不代表来源在线或已取得结果。'
              : 'Manage visual and metric monitoring together. Enabled does not mean the source is online or results are available.'}
          </p>
        </div>
        {admin && (
          <Button variant="signal" onClick={() => setEditing(true)}>
            <Add size={16} />
            {zh ? '新建规则' : 'New rule'}
          </Button>
        )}
      </div>
      {channelId && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline">{zh ? '当前摄像头的规则' : 'Rules for this camera'}</Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = new URLSearchParams(params)
              next.delete('channel')
              setParams(next)
            }}
          >
            {zh ? '显示全部规则' : 'Show all rules'}
          </Button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-crit/40 p-3 text-sm text-crit"
        >
          {error}
          <Button variant="outline" onClick={() => void refresh().catch((e) => toast.error(e.message))}>
            <Renew size={14} />
            {zh ? '重试' : 'Retry'}
          </Button>
        </div>
      )}
      {!loaded && (
        <div role="status" className="skeleton h-32" aria-label={zh ? '加载规则' : 'Loading rules'} />
      )}
      {loaded && (
        <Panel>
          <Table className="min-w-[850px]">
            <TableHeader>
              <TableRow>
                {[
                  zh ? '名称 / 类型' : 'Name / type',
                  zh ? '来源' : 'Source',
                  zh ? '条件' : 'Condition',
                  zh ? '启用' : 'Enabled',
                  zh ? '运行状态' : 'Runtime',
                  zh ? '操作' : 'Actions',
                ].map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <Button
                      variant="ghost"
                      className="h-auto max-w-64 whitespace-normal px-0 text-left"
                      onClick={() => select(rule.id)}
                    >
                      {rule.name}
                    </Button>
                    <div className="mt-1">
                      <Badge variant="outline">
                        {rule.legacy
                          ? zh
                            ? '历史规则（无执行端）'
                            : 'Legacy rule (no producer)'
                          : typeText(rule.type, zh)}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-52 whitespace-normal">{rule.sourceName || '—'}</TableCell>
                  <TableCell className="max-w-64 whitespace-normal text-ink-2">
                    {condition(rule, data, zh)}
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={`${zh ? '启用' : 'Enable'} ${rule.name}`}
                      checked={rule.enabled}
                      disabled={
                        !admin || busy || rule.type === 'external' || (rule.type === 'sim' && !rule.enabled)
                      }
                      onCheckedChange={(value) => void change(rule, value)}
                    />
                  </TableCell>
                  <TableCell>
                    <div>{runtimeText(rule.runtime.status, zh)}</div>
                    <div className="mt-1 text-xs text-ink-3">
                      {rule.runtime.lastObservedAt
                        ? new Date(rule.runtime.lastObservedAt).toLocaleString()
                        : zh
                          ? '尚无观测时间'
                          : 'No observation time'}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => select(rule.id)}>
                        {zh ? '详情' : 'Details'}
                      </Button>
                      {((operator && rule.type === 'vision') || (admin && rule.type === 'threshold')) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${admin ? (zh ? '编辑' : 'Edit') : zh ? '预览' : 'Preview'} ${rule.name}`}
                          onClick={() => setEditing(rule)}
                        >
                          <Edit size={15} />
                        </Button>
                      )}
                      {admin &&
                        ['vision', 'threshold'].includes(rule.type) &&
                        !(rule.config as DetectionRule).builtin && (
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            aria-label={`${zh ? '删除' : 'Delete'} ${rule.name}`}
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  message: `${zh ? '删除规则' : 'Delete rule'} · ${rule.name}?`,
                                  destructive: true,
                                }))
                              )
                                return
                              setBusy(true)
                              try {
                                await monitoringRequest(
                                  site,
                                  rule.type === 'vision'
                                    ? `/vision/configs/${encodeURIComponent(rule.id)}`
                                    : `/rules/${encodeURIComponent(rule.id)}`,
                                  'DELETE',
                                )
                                await refresh()
                              } catch (e) {
                                toast.error((e as Error).message)
                              } finally {
                                setBusy(false)
                              }
                            }}
                          >
                            <TrashCan size={15} />
                          </Button>
                        )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!shown.length && (
            <EmptyNote>{zh ? '没有符合条件的规则。' : 'No rules match this view.'}</EmptyNote>
          )}
        </Panel>
      )}
      {editing && (
        <MonitoringRuleEditor
          rule={editing === true ? undefined : editing}
          channelId={channelId}
          data={data}
          onClose={closeEditor}
          onSaved={() => {
            closeEditor()
            void refresh().catch((e) => toast.error(e.message))
          }}
        />
      )}
      {selected && (
        <MonitoringRuleDetail
          rule={selected}
          data={data}
          onClose={() => select()}
          onEdit={
            (operator && selected.type === 'vision') || (admin && selected.type === 'threshold')
              ? () => {
                  select()
                  setEditing(selected)
                }
              : undefined
          }
          onViewEvents={() => onViewEvents(selected.id)}
        />
      )}
      {loaded && params.get('rule') && !selected && (
        <EmptyNote>
          {zh
            ? '该规则当前不存在或已删除；事件详情中的冻结配置仍可查看。'
            : 'This rule is unavailable or deleted. Its frozen configuration remains available in event details.'}
        </EmptyNote>
      )}
    </div>
  )
}

function MonitoringRuleDetail({
  rule,
  data,
  onClose,
  onEdit,
  onViewEvents,
}: {
  rule: MonitoringRule
  data: MonitoringData
  onClose: () => void
  onEdit?: () => void
  onViewEvents: () => void
}) {
  const zh = useLang((s) => s.lang) === 'zh',
    site = useSite((s) => s.siteId),
    channels = useApp((s) => s.channels)
  const [results, setResults] = useState<VisionResult[]>([]),
    [readings, setReadings] = useState<Reading[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [result, setResult] = useState<VisionResult | null>(null)
  const channel = channels.find((c) => c.id === rule.channelId),
    c = rule.config as DetectionRule
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const load = async () => {
      try {
        if (rule.type === 'vision') {
          const d = await monitoringRequest<VisionData>(
            site,
            `/vision?configId=${encodeURIComponent(rule.id)}`,
          )
          if (active) setResults(d.results)
        } else if (rule.type === 'threshold' && c.robotId) {
          const d = await monitoringRequest<{ readings: Reading[] }>(
            site,
            `/robots/${encodeURIComponent(c.robotId)}/readings?metric=${encodeURIComponent(c.metric ?? '')}`,
          )
          if (active) setReadings(d.readings ?? [])
        }
      } catch (e) {
        if (active) setError((e as Error).message)
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [site, rule.id, rule.type, c.robotId, c.metric])
  return (
    <Modal wide title={zh ? '规则详情' : 'Rule details'} onClose={onClose}>
      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">{rule.name}</h2>
            <div className="mt-1 flex gap-2">
              <Badge variant="outline">
                {rule.legacy
                  ? zh
                    ? '历史规则（无执行端）'
                    : 'Legacy rule (no producer)'
                  : typeText(rule.type, zh)}
              </Badge>
              <SevTag sev={rule.severity} />
            </div>
          </div>
          <Button variant="ghost" size="icon" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}>
            <Close size={16} />
          </Button>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {[
            [zh ? '条件' : 'Condition', condition(rule, data, zh)],
            [zh ? '来源' : 'Source', rule.sourceName],
            [
              zh ? '启用设置' : 'Enabled setting',
              rule.enabled ? (zh ? '已启用' : 'Enabled') : zh ? '已停用' : 'Disabled',
            ],
            [zh ? '运行状态' : 'Runtime', runtimeText(rule.runtime.status, zh)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-ink-3">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {rule.legacy && (
          <p className="rounded-md border border-line p-3 text-sm text-ink-2">
            {zh
              ? '该历史规则没有执行端，不代表可运行视觉模型。请新建真实视觉规则。'
              : 'This legacy rule has no executing producer and is not a runnable visual model. Create a visual rule with a registered source.'}
          </p>
        )}
        {rule.type === 'sim' && (
          <p className="rounded-md border border-line p-3 text-sm text-ink-2">
            {zh
              ? '这是演示事件生成规则，不运行视觉模型；不能在此启用或新建。'
              : 'This rule generates demo events and does not run a visual model. It cannot be enabled or created here.'}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {onEdit && (
            <Button variant="outline" onClick={onEdit}>
              {zh ? '打开规则配置' : 'Open rule configuration'}
            </Button>
          )}
          <Button variant="outline" onClick={onViewEvents}>
            {zh ? '查看事件' : 'View events'}
          </Button>
          {channel && (
            <Button asChild variant="outline">
              <Link to={`/live?src=${encodeURIComponent(channel.streamKey ?? channel.id)}`}>
                <Video size={14} />
                {zh ? '查看视频' : 'View video'}
              </Link>
            </Button>
          )}
        </div>
        {rule.type === 'vision' && (
          <>
            <div>
              <h3 className="font-medium">{zh ? '观测历史' : 'Observation history'}</h3>
              <p className="mt-1 text-xs text-ink-3">
                {zh
                  ? '最近200条，保留7天；每条保留当时配置。预览不创建事件，延迟结果仅归档。'
                  : 'Latest 200, retained for 7 days with their configuration. Previews create no events; delayed results are archived only.'}
              </p>
            </div>
            {loading ? (
              <p role="status">{zh ? '加载中…' : 'Loading…'}</p>
            ) : (
              <Table className="min-w-[520px]">
                <TableHeader>
                  <TableRow>
                    {[
                      zh ? '采集时间' : 'Captured',
                      zh ? '结果' : 'Result',
                      zh ? '读数' : 'Reading',
                      zh ? '用途' : 'Purpose',
                      '',
                    ].map((h, i) => (
                      <TableHead key={i}>{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{new Date(r.capturedAt).toLocaleString()}</TableCell>
                      <TableCell>{observationStatus(r.status, zh)}</TableCell>
                      <TableCell className="max-w-36 whitespace-normal">
                        {r.value !== null ? `${r.value} ${r.config.unit}` : r.text || '—'}
                      </TableCell>
                      <TableCell>
                        {r.jobId
                          ? zh
                            ? '预览'
                            : 'Preview'
                          : r.late
                            ? zh
                              ? '延迟'
                              : 'Delayed'
                            : zh
                              ? '监测'
                              : 'Monitoring'}
                      </TableCell>
                      <TableCell>
                        <Button variant="outline" size="sm" onClick={() => setResult(r)}>
                          {zh ? '查看观测' : 'Review observation'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {!loading && !results.length && !error && (
              <EmptyNote>{zh ? '暂无观测。' : 'No observations yet.'}</EmptyNote>
            )}
          </>
        )}
        {rule.type === 'threshold' && (
          <>
            <h3 className="font-medium">{zh ? '指标读数' : 'Metric readings'}</h3>
            <p className="text-xs text-ink-3">
              {zh
                ? '以下是机器人上报的读数，不等同于每次规则执行的观测日志。事件保存触发时读数。'
                : 'These are reported metric samples, not a log of every rule evaluation. Events preserve the triggering reading.'}
            </p>
            {loading ? (
              <p role="status">{zh ? '加载中…' : 'Loading…'}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{zh ? '采集时间' : 'Captured'}</TableHead>
                    <TableHead>{zh ? '读数' : 'Reading'}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {readings.slice(0, 100).map((r, i) => (
                    <TableRow key={`${r.ts}-${i}`}>
                      <TableCell>{new Date(r.ts).toLocaleString()}</TableCell>
                      <TableCell className="mono">
                        {r.value} {data.metrics.find((m) => m.id === r.metric)?.unit ?? ''}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {!loading && !readings.length && !error && (
              <EmptyNote>{zh ? '尚无已上报读数。' : 'No reported readings yet.'}</EmptyNote>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-crit">
            {error}
          </p>
        )}
        {result && <VisionObservationDialog result={result} onClose={() => setResult(null)} />}
      </div>
    </Modal>
  )
}
