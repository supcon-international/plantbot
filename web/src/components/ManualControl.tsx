import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Minus, Plus, RotateCcw, RotateCw, Square, Gamepad2 } from 'lucide-react'
import { apiFetch, useApp, useCan, useSite } from '../lib/store'
import { useLang } from '../lib/i18n'
import { Panel, PanelHead, EmptyNote } from './ui'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Slider } from './ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { FeedPlayer } from './StreamPlayer'
import { useConfirm } from './ConfirmDialog'
import type { StreamSession } from '../lib/types'

type Pose = { pan: number; tilt: number; zoom: number; ts: number }
type Lease = { id: string; owner: string; status: 'starting' | 'active' | 'stopping' | 'closed' | 'failed'; note?: string; sequence: number }
type Camera = { id: string; label: string; position?: Pose; ptz?: { manual?: 'position' } }
type Axes = Record<string, number>

function CameraVideo({ siteId, channelId }: { siteId: string; channelId: string }) {
  const [session, setSession] = useState<StreamSession | null>(null), [error, setError] = useState(false)
  const zh = useLang(s => s.lang) === 'zh'
  useEffect(() => {
    let dead = false, id: string | undefined, timer: ReturnType<typeof setTimeout>
    const prefix = `/api/sites/${encodeURIComponent(siteId)}`
    const close = (sid: string) => void apiFetch(`${prefix}/stream-sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }).catch(() => {})
    setSession(null); setError(false)
    const renew = (s: StreamSession) => {
      if (!s.expiresAt) return
      timer = setTimeout(async () => {
        try {
          const r = await apiFetch(`${prefix}/stream-sessions/${encodeURIComponent(s.id)}/renew`, { method: 'POST' })
          const b = await r.json()
          if (!r.ok || !b.session) throw new Error('renew failed')
          if (!dead) { setSession(b.session); renew(b.session) }
        } catch { if (!dead) setError(true) }
      }, Math.max(1000, s.expiresAt - Date.now() - 120_000))
    }
    void (async () => {
      try {
        const r = await apiFetch(`${prefix}/channels/${encodeURIComponent(channelId)}/sessions`, { method: 'POST' })
        const b = await r.json()
        if (!r.ok || !b.session) throw new Error('video unavailable')
        if (dead) return close(b.session.id)
        id = b.session.id; setSession(b.session); renew(b.session)
      } catch { if (!dead) setError(true) }
    })()
    return () => { dead = true; clearTimeout(timer); if (id) close(id) }
  }, [siteId, channelId])
  return <div className="aspect-video overflow-hidden bg-black" data-testid="control-video">
    {error || session?.relayOnline === false ? <EmptyNote>{zh ? '视频暂不可用，请检查摄像头连接。' : 'Video is unavailable. Check the camera connection.'}</EmptyNote>
      : session ? <FeedPlayer stream={session.url} file={session.protocol === 'file' ? session.url : undefined} />
        : <div className="skeleton h-full" />}
  </div>
}

export function ManualControl(props: { robotId: string; channelId?: string; onCapture?: (position: Pose) => void }) {
  const siteId = useSite(s => s.siteId)
  return <div data-testid={props.channelId ? 'manual-ptz' : 'manual-drive'}><ControlPanel key={`${siteId}:${props.robotId}:${props.channelId ?? 'drive'}`} siteId={siteId} {...props} /></div>
}

function ControlPanel({ siteId, robotId, channelId, onCapture }: { siteId: string; robotId: string; channelId?: string; onCapture?: (position: Pose) => void }) {
  const zh = useLang(s => s.lang) === 'zh', l = (en: string, cn: string) => zh ? cn : en
  const confirm = useConfirm()
  const [taskActive, setTaskActive] = useState(false)
  const can = useCan('operator'), target = channelId ? 'ptz' : 'drive'
  const robot = useApp(s => s.robots.find(r => r.id === robotId))
  const telemetry = useApp(s => s.telemetry[robotId])
  const [lease, setLease] = useState<Lease | null>(null), [cameras, setCameras] = useState<Camera[]>([])
  const [selected, setSelected] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [owned, setOwned] = useState(false), [speed, setSpeed] = useState(0.2), [pressed, setPressed] = useState('')
  const token = useRef<{ id: string; value: string } | null>(null), axes = useRef<Axes>({})
  const sequence = useRef(0), inFlight = useRef(false), alive = useRef(true), root = useRef<HTMLDivElement>(null)
  const prefix = `/api/sites/${encodeURIComponent(siteId)}/robots/${encodeURIComponent(robotId)}/control`
  const camera = cameras.find(c => c.id === (channelId ?? selected)) ?? cameras[0]
  const capable = target === 'drive' ? !!robot?.teleop : !!camera?.ptz?.manual
  const online = telemetry?.mode !== 'offline' && !!telemetry
  const release = useCallback(() => {
    const current = token.current
    token.current = null; axes.current = {}
    if (alive.current) { setOwned(false); setPressed('') }
    if (current) void apiFetch(`${prefix}/${current.id}`, { method: 'DELETE', headers: { 'x-control-token': current.value }, keepalive: true }).catch(() => {})
  }, [prefix])
  const refresh = useCallback(async () => {
    const r = await apiFetch(prefix)
    const b = await r.json()
    if (!r.ok) throw new Error(b.message || b.error || 'Control unavailable')
    if (!alive.current) return
    setLease(b.session); setCameras(b.cameras); setTaskActive(b.taskActive === true)
    if (token.current && (!b.session || b.session.id !== token.current.id || !['starting', 'active'].includes(b.session.status))) release()
  }, [prefix, release])
  const sendInput = useCallback(async (urgent = false) => {
    const current = token.current
    if (!current || (!urgent && inFlight.current)) return
    const seq = ++sequence.current
    inFlight.current = true
    try {
      const r = await apiFetch(`${prefix}/${current.id}/input`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-control-token': current.value },
        body: JSON.stringify({ sequence: seq, axes: axes.current }), signal: AbortSignal.timeout(800) })
      const b = await r.json()
      if (r.status === 409 && (b.message || b.error) === 'Stale input sequence') return
      if (r.status === 409 && (b.message || b.error) === 'Control session is stopping or closed') { release(); return }
      if (!r.ok) throw new Error(b.message || b.error || 'Control connection lost')
      if (alive.current && token.current?.id === current.id && seq === sequence.current) setLease(b.session)
    } catch (e) {
      if (alive.current && token.current?.id === current.id) { setError(e instanceof Error ? e.message : 'Control connection lost'); release() }
    } finally { inFlight.current = false }
  }, [prefix, release])
  useEffect(() => {
    alive.current = true
    void refresh().catch(e => { if (alive.current) setError(e.message) })
    const poll = setInterval(() => void refresh().catch(() => { if (token.current) release() }), 500)
    const heartbeat = setInterval(() => void sendInput(), 180)
    const hidden = () => { if (document.hidden) release() }
    window.addEventListener('blur', release)
    window.addEventListener('pagehide', release)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      alive.current = false; release(); clearInterval(poll); clearInterval(heartbeat)
      window.removeEventListener('blur', release); window.removeEventListener('pagehide', release); document.removeEventListener('visibilitychange', hidden)
    }
  }, [refresh, release, sendInput])
  const takeControl = async () => {
    if (taskActive && !await confirm({ title: l('End task and take control?', '结束任务并接管？'), message: l('The current navigation or inspection will be ended. Manual controls become available after the robot confirms it has stopped.', '当前导航或巡检将结束。机器人确认停止后开放手动控制。'), confirmText: l('End task and take control', '结束任务并接管'), destructive: true })) return
    setBusy(true); setError('')
    try {
      const r = await apiFetch(prefix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, channelId, interrupt: taskActive }) })
      const b = await r.json()
      if (!r.ok) throw new Error(b.message || b.error || 'Cannot acquire control')
      if (!alive.current) { void apiFetch(`${prefix}/${b.session.id}`, { method: 'DELETE', headers: { 'x-control-token': b.token } }); return }
      token.current = { id: b.session.id, value: b.token }; axes.current = {}; sequence.current = 0
      setLease(b.session); setOwned(true); root.current?.focus({ preventScroll: true })
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  const ready = owned && lease?.status === 'active' && online
  const directional = robot?.teleop?.mode === 'direction'
  const driveSpeed = directional ? 1 : speed
  const move = (name: string, next: Axes) => {
    if (!ready) return
    axes.current = next; setPressed(name); void sendInput(true)
  }
  const stop = () => { if (!Object.values(axes.current).some(Boolean)) return; axes.current = {}; setPressed(''); void sendInput(true) }
  const controls: { key: string; title: string; icon: typeof ArrowLeft; axes: Axes }[] = target === 'drive' ? [
    { key: 'q', title: directional ? l('Left', '向左') : l('Strafe left', '向左平移'), icon: ArrowLeft, axes: { lateral: Math.min(driveSpeed, robot?.teleop?.lateral ?? 0) } },
    { key: 'w', title: l('Forward', '前进'), icon: ArrowUp, axes: { forward: Math.min(driveSpeed, robot?.teleop?.forward ?? 0) } },
    { key: 'e', title: directional ? l('Right', '向右') : l('Strafe right', '向右平移'), icon: ArrowRight, axes: { lateral: -Math.min(driveSpeed, robot?.teleop?.lateral ?? 0) } },
    { key: 'a', title: l('Turn left', '向左转'), icon: RotateCcw, axes: { turn: Math.min(speed, robot?.teleop?.turn ?? 0) } },
    { key: 's', title: l('Backward', '后退'), icon: ArrowDown, axes: { forward: -Math.min(driveSpeed, robot?.teleop?.forward ?? 0) } },
    { key: 'd', title: l('Turn right', '向右转'), icon: RotateCw, axes: { turn: -Math.min(speed, robot?.teleop?.turn ?? 0) } },
  ] : [
    { key: 'ArrowLeft', title: l('Pan left', '云台向左'), icon: ArrowLeft, axes: { pan: -1 } },
    { key: 'ArrowUp', title: l('Tilt up', '云台向上'), icon: ArrowUp, axes: { tilt: 1 } },
    { key: 'ArrowRight', title: l('Pan right', '云台向右'), icon: ArrowRight, axes: { pan: 1 } },
    { key: '-', title: l('Zoom out', '缩小'), icon: Minus, axes: { zoom: -1 } },
    { key: 'ArrowDown', title: l('Tilt down', '云台向下'), icon: ArrowDown, axes: { tilt: -1 } },
    { key: '=', title: l('Zoom in', '放大'), icon: Plus, axes: { zoom: 1 } },
  ]
  const status = lease?.status
  const label = status === 'active' ? l('Control acquired', '已取得控制权') : status === 'starting' ? l('Preparing control', '正在准备控制')
    : status === 'stopping' ? l('Confirming stop', '正在确认停止') : status === 'failed' ? l('Stop not confirmed', '停止尚未确认') : l('Not acquired', '未接管')
  return <Panel className="my-3 overflow-hidden" data-testid={`manual-${target}`}>
    <PanelHead label={target === 'drive' ? l('Robot teleoperation', '机器人遥操作') : l('Manual camera control', '云台手动控制')} right={<Badge variant="outline">{label}</Badge>} />
    <div ref={root} tabIndex={0} className="grid gap-4 p-3 outline-none lg:grid-cols-[minmax(0,1fr)_280px]" onKeyDown={e => {
      if ((e.target as HTMLElement).matches('input,textarea,select,[role=slider]')) return
      if (e.code === 'Space' || e.key === 'Escape') { e.preventDefault(); stop(); return }
      const c = controls.find(c => c.key.toLowerCase() === e.key.toLowerCase())
      if (c && ready) { e.preventDefault(); if (!e.repeat) move(c.key, c.axes) }
    }} onKeyUp={e => { if (controls.some(c => c.key.toLowerCase() === e.key.toLowerCase())) { e.preventDefault(); stop() } }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) stop() }}>
      <div className="min-w-0 space-y-2">
        {!channelId && cameras.length > 1 && <Select value={camera?.id ?? ''} onValueChange={setSelected} disabled={owned}>
          <SelectTrigger aria-label={l('Driving camera', '驾驶摄像头')}><SelectValue /></SelectTrigger>
          <SelectContent>{cameras.map(c => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
        </Select>}
        {camera ? <CameraVideo key={camera.id} siteId={siteId} channelId={camera.id} /> : <EmptyNote>{l('No camera is connected.', '尚未接入摄像头。')}</EmptyNote>}
        {target === 'drive' && <div className="flex gap-4 text-xs mono"><span>{(telemetry?.speed ?? 0).toFixed(2)} m/s</span><span>{(telemetry?.battery ?? 0).toFixed(0)}%</span><span>{telemetry?.mode ?? 'offline'}</span></div>}
        {target === 'ptz' && camera?.position && <div className="mono text-xs">{camera.position.pan.toFixed(1)}° / {camera.position.tilt.toFixed(1)}° · {camera.position.zoom.toFixed(1)}×</div>}
      </div>
      <div className="min-w-0 space-y-3">
        {!capable && <p className="text-sm text-ink-2">{l('This adapter does not provide this control capability.', '当前适配器尚未提供这项控制能力。')}</p>}
        {error && <p role="alert" className="text-sm text-ink-2">{error}</p>}
        {lease?.note && <p className="text-xs text-ink-3">{lease.note}</p>}
        {can && capable && <>
          {!owned ? <Button variant="signal" disabled={busy || !!lease || !online} onClick={() => void takeControl()}><Gamepad2 size={15} />{taskActive ? l('End task & take control', '结束任务并接管') : l('Take control', '取得控制权')}</Button>
            : <Button variant="outline" onClick={release}>{l('Release control', '释放控制权')}</Button>}
          {lease && !owned && <div className="space-y-2"><p className="text-xs">{l('Operator: ', '操作员：')}{lease.owner}</p><Button variant="outline" onClick={async () => { await apiFetch(`${prefix}/${lease.id}/stop`, { method: 'POST' }); await refresh() }}>{l('Request stop', '请求停止')}</Button></div>}
          {target === 'drive' && (directional ? <p className="text-xs text-ink-3">{l('Directional control · vendor speed setting 3', '方向控制 · 厂商速度档位 3')}</p> : <div className="space-y-2"><div className="flex justify-between text-xs"><span>{l('Speed limit', '速度上限')}</span><span className="mono">{speed.toFixed(2)} m/s</span></div><Slider aria-label={l('Speed limit', '速度上限')} min={0.05} max={0.5} step={0.05} value={[speed]} onValueChange={v => { stop(); setSpeed(v[0]) }} /></div>)}
          <div className="grid grid-cols-3 gap-2">{controls.map(c => <Button key={c.key} type="button" variant={pressed === c.key ? 'signal' : 'utility'} className="h-14 touch-none select-none" aria-label={c.title} title={c.title} disabled={!ready || !Object.values(c.axes).some(Boolean)}
            onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); root.current?.focus({ preventScroll: true }); move(c.key, c.axes) }}
            onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onContextMenu={e => e.preventDefault()}>
            <c.icon size={19} /><span className="mono text-[10px]">{c.key.length === 1 ? c.key.toUpperCase() : ''}</span>
          </Button>)}</div>
          <Button variant="outline" className="w-full" disabled={!owned} onClick={stop}><Square size={15} />{l('Stop · Space', '停止 · 空格')}</Button>
          <p className="text-xs leading-relaxed text-ink-3">{target === 'drive'
            ? l('Hold a direction to move. Release to stop. Leaving this page releases control.', '按住方向移动，松开停止。离开页面后释放控制权。')
            : l('Hold to adjust in small steps. Release to hold position.', '按住方向逐步调整，松开后保持当前位置。')}</p>
          {target === 'ptz' && onCapture && <Button variant="outline" disabled={!camera?.position || Date.now() - camera.position.ts > 1500} onClick={() => { if (camera?.position) { release(); onCapture(camera.position) } }}>{l('Save position as preset', '保存当前位置为预置点')}</Button>}
        </>}
        {!can && <p className="text-xs text-ink-3">{l('Sign in as an operator to use manual controls.', '请使用操作员账户登录后进行手动控制。')}</p>}
      </div>
    </div>
  </Panel>
}
