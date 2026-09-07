import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Play, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch, useApp, useCan, useSite } from '../lib/store'
import { useLang } from '../lib/i18n'
import { useConfirm } from './ConfirmDialog'
import { Panel, EmptyNote } from './ui'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

type Clip = {
  id: string
  channelId: string
  label: string
  startedAt: number
  endedAt: number
  bytes: number
  url: string
}
type Policy = { channelId: string; enabled: boolean; retentionDays: number; recording: boolean; error: string | null }
const localDate = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)

export function RecordingArchive() {
  const zh = useLang((s) => s.lang) === 'zh'
  const tr = (en: string, cn: string) => (zh ? cn : en)
  const siteId = useSite((s) => s.siteId)
  const channels = useApp((s) => s.channels)
  const admin = useCan('admin')
  const confirm = useConfirm()
  const [channel, setChannel] = useState('all')
  const [from, setFrom] = useState(() => localDate(new Date(Date.now() - 86400_000)))
  const [to, setTo] = useState('')
  const [clips, setClips] = useState<Clip[]>([])
  const [policies, setPolicies] = useState<Policy[]>([])
  const [selected, setSelected] = useState<Clip | null>(null)
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [storage, setStorage] = useState(2048)
  const [segmentSeconds, setSegmentSeconds] = useState(60)
  const path = `/api/sites/${encodeURIComponent(siteId)}`
  const requestVersion = useRef(0)
  const currentView = `${path}|${from}|${to}|${offset}|${channel}|${zh}`
  const activeView = useRef(currentView)
  activeView.current = currentView
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestVersion.current++
    }
  }, [])
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const view = `${path}|${from}|${to}|${offset}|${channel}|${zh}`
      if (!mounted.current || signal?.aborted || view !== activeView.current) return
      const version = ++requestVersion.current
      const isCurrent = () =>
        mounted.current && !signal?.aborted && version === requestVersion.current && view === activeView.current
      const since = from ? new Date(from).getTime() : 0,
        until = to ? new Date(to).getTime() : Date.now()
      if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) {
        setError(zh ? '请选择有效的起止时间。' : 'Choose a valid time range.')
        setLoading(false)
        return
      }
      const query = new URLSearchParams({
        since: String(since),
        until: String(until),
        offset: String(offset),
        limit: '25',
      })
      if (channel !== 'all') query.set('channelId', channel)
      try {
        const [a, b] = await Promise.all([
          apiFetch(`${path}/recordings?${query}`, { signal }),
          apiFetch(`${path}/recording-policies`, { signal }),
        ])
        if (!a.ok || !b.ok) throw new Error(zh ? '录像列表读取失败。' : 'Could not load recordings.')
        const [data, config] = await Promise.all([a.json(), b.json()])
        if (!isCurrent()) return
        setClips(data.recordings)
        setTotal(data.total)
        setPolicies(config.policies)
        setStorage(config.maxStorageMB)
        setSegmentSeconds(config.segmentSeconds)
        setError('')
      } catch (e) {
        if (isCurrent()) setError(e instanceof Error ? e.message : 'Request failed')
      } finally {
        if (isCurrent()) setLoading(false)
      }
    },
    [path, from, to, offset, channel, zh],
  )
  useEffect(() => {
    setChannel('all')
    setSelected(null)
    setOffset(0)
    setClips([])
    setPolicies([])
    setTotal(0)
    setBusy(false)
    setError('')
  }, [siteId])
  useEffect(() => {
    setSelected(null)
  }, [from, to, channel])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void load(controller.signal)
    const timer = setInterval(() => void load(controller.signal), 5000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [load])
  const policy = policies.find((p) => p.channelId === channel)
  const recordable = channels.filter((c) => c.source.kind === 'file' || c.source.kind === 'rtsp')
  const updatePolicy = async (enabled: boolean, retentionDays: number) => {
    setBusy(true)
    try {
      const r = await apiFetch(`${path}/recording-policies/${encodeURIComponent(channel)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, retentionDays }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      if (!mounted.current || siteId !== useSite.getState().siteId) return
      await load()
      toast.success(tr('Recording settings saved', '录像设置已保存'))
    } catch (e) {
      if (mounted.current && siteId === useSite.getState().siteId)
        toast.error(e instanceof Error ? e.message : 'Request failed')
    } finally {
      if (mounted.current && siteId === useSite.getState().siteId) setBusy(false)
    }
  }
  const remove = async (clip: Clip) => {
    if (
      !(await confirm({
        message: tr('Delete this recording permanently?', '永久删除这段录像？'),
        destructive: true,
        confirmText: tr('Delete', '删除'),
      })) ||
      !mounted.current ||
      siteId !== useSite.getState().siteId
    )
      return
    setBusy(true)
    try {
      const r = await apiFetch(`${path}/recordings/${clip.id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(tr('Could not delete recording', '删除录像失败'))
      if (!mounted.current || siteId !== useSite.getState().siteId) return
      if (selected?.id === clip.id) setSelected(null)
      await load()
    } catch (e) {
      if (mounted.current && siteId === useSite.getState().siteId)
        toast.error(e instanceof Error ? e.message : 'Request failed')
    } finally {
      if (mounted.current && siteId === useSite.getState().siteId) setBusy(false)
    }
  }
  return (
    <div className="space-y-3" data-testid="recording-archive">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-48 flex-1 space-y-1 text-xs text-ink-2">
          {tr('Channel', '视频通道')}
          <Select
            value={channel}
            onValueChange={(v) => {
              setChannel(v)
              setOffset(0)
              setSelected(null)
            }}
          >
            <SelectTrigger aria-label={tr('Recording channel', '录像通道')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr('All channels', '全部通道')}</SelectItem>
              {channels.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-xs text-ink-2">
          {tr('From (local time)', '开始（本地时间）')}
          <Input
            aria-label={tr('Recording start time', '录像开始时间')}
            type="datetime-local"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value)
              setOffset(0)
            }}
          />
        </label>
        <label className="space-y-1 text-xs text-ink-2">
          {tr('To (blank = now)', '结束（留空至今）')}
          <Input
            aria-label={tr('Recording end time', '录像结束时间')}
            type="datetime-local"
            value={to}
            onChange={(e) => {
              setTo(e.target.value)
              setOffset(0)
            }}
          />
        </label>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} />
          {tr('Refresh', '刷新')}
        </Button>
      </div>
      {admin && channel !== 'all' && recordable.some((c) => c.id === channel) && (
        <Panel className="flex flex-wrap items-center gap-4 p-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              aria-label={tr('Record this channel', '录制此通道')}
              checked={policy?.enabled ?? false}
              disabled={busy}
              onCheckedChange={(enabled) => void updatePolicy(enabled, policy?.retentionDays ?? 7)}
            />
            {tr('Record this channel', '录制此通道')}
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-2">
            {tr('Retention', '保留期限')}
            <Select
              value={String(policy?.retentionDays ?? 7)}
              onValueChange={(v) => void updatePolicy(policy?.enabled ?? false, Number(v))}
              disabled={busy}
            >
              <SelectTrigger className="w-28" aria-label={tr('Retention days', '保留天数')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 3, 7, 14, 30].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} {tr('days', '天')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <span className="text-xs text-ink-3" role="status">
            {policy?.error ||
              (policy?.recording
                ? tr('Recording · completed segments appear below', '录制中 · 完成的片段将出现在下方')
                : policy?.enabled
                  ? tr('Waiting for the first completed segment…', '等待首段录像完成…')
                  : tr('Recording is off', '录像已关闭'))}
          </span>
        </Panel>
      )}
      <p className="text-xs text-ink-3">
        {tr(
          `Only video recorded after enabling is searchable. Segments are about ${segmentSeconds}s; keyframes determine boundaries. Shared storage budget: ${storage} MB; oldest segments expire first.`,
          `仅检索启用录制后的录像。片段约 ${segmentSeconds} 秒，按视频关键帧分段。共享存储上限 ${storage} MB，最早的片段优先清理。`,
        )}
      </p>
      {selected && (
        <Panel className="overflow-hidden">
          <video
            key={selected.id}
            className="max-h-[480px] w-full bg-black"
            src={selected.url}
            controls
            autoPlay
            muted
            playsInline
            onError={() =>
              toast.error(
                tr(
                  'This recording is unavailable or its codec is unsupported by your browser.',
                  '录像已失效，或浏览器不支持该视频编码。',
                ),
              )
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-2 p-3">
            <span className="text-sm">
              {selected.label} · {new Date(selected.startedAt).toLocaleString()}
            </span>
            <Button variant="outline" asChild>
              <a href={`${selected.url}?download=1`} download>
                <Download size={14} />
                {tr('Download MP4', '下载 MP4')}
              </a>
            </Button>
          </div>
        </Panel>
      )}
      {error ? (
        <p className="border border-crit p-3 text-sm text-crit" role="alert">
          {error}
        </p>
      ) : loading ? (
        <div className="skeleton h-40" />
      ) : clips.length === 0 ? (
        <EmptyNote>
          {tr(
            'No recordings in this time range. Select a channel to enable recording, or choose another time range.',
            '此时间范围内没有录像。可选择通道启用录制，或调整时间范围。',
          )}
        </EmptyNote>
      ) : (
        <Panel className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr('Channel', '通道')}</TableHead>
                <TableHead>{tr('Recorded at', '录制时间')}</TableHead>
                <TableHead>{tr('Duration', '时长')}</TableHead>
                <TableHead>{tr('Size', '大小')}</TableHead>
                <TableHead className="text-right">{tr('Actions', '操作')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clips.map((c) => (
                <TableRow key={c.id} data-state={selected?.id === c.id ? 'selected' : undefined}>
                  <TableCell>{c.label}</TableCell>
                  <TableCell className="mono whitespace-nowrap">{new Date(c.startedAt).toLocaleString()}</TableCell>
                  <TableCell className="mono">{Math.round((c.endedAt - c.startedAt) / 1000)}s</TableCell>
                  <TableCell className="mono">{(c.bytes / 1048576).toFixed(1)} MB</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setSelected(c)}>
                        <Play size={13} />
                        {tr('Play', '播放')}
                      </Button>
                      <Button variant="ghost" size="iconSm" asChild>
                        <a aria-label={tr('Download recording', '下载录像')} href={`${c.url}?download=1`} download>
                          <Download size={14} />
                        </a>
                      </Button>
                      {admin && (
                        <Button
                          variant="ghost"
                          size="iconSm"
                          disabled={busy}
                          aria-label={tr('Delete recording', '删除录像')}
                          onClick={() => void remove(c)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
      <div className="flex items-center justify-between text-xs text-ink-3">
        <span>
          {total} {tr('recordings', '段录像')}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            {tr('Previous', '上一页')}
          </Button>
          <Button variant="outline" disabled={offset + 25 >= total || loading} onClick={() => setOffset(offset + 25)}>
            {tr('Next', '下一页')}
          </Button>
        </div>
      </div>
    </div>
  )
}
