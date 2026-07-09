import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ArrowUpRight, Radio } from 'lucide-react'
import { useApp, useHistory } from '../lib/store'
import { useT, useAgo } from '../lib/i18n'
import { Panel, PanelHead, Spark, BatteryBar, SevDot, ModeChip, EmptyNote } from '../components/ui'
import { VideoThumb } from '../components/StreamPlayer'
import { OpsMap, type MapSel } from '../components/OpsMap'
import type { RobotSpec } from '../lib/types'

function KpiRow() {
  const robots = useApp((s) => s.robots)
  const telemetry = useApp((s) => s.telemetry)
  const events = useApp((s) => s.events)
  const missions = useApp((s) => s.missions)
  const t = useT()

  const ready = Object.values(telemetry).filter((x) => x.battery > 20).length
  const activeMissions = missions.filter((m) => m.status === 'active').length
  const queued = missions.filter((m) => m.status === 'queued').length
  const open = events.filter((e) => !e.acked && (e.severity === 'critical' || e.severity === 'high')).length
  const detections24h = events.filter((e) => Date.now() - e.ts < 24 * 3600_000).length
  const tel = Object.values(telemetry)
  const rssi = tel.length ? Math.round(tel.reduce((a, x) => a + x.rssi, 0) / tel.length) : null

  const tiles: { label: string; value: string | number; sub?: string; tone?: string }[] = [
    { label: t('ops.fleetReady'), value: `${ready}/${robots.length || '—'}`, sub: t('ops.fleetReady.sub') },
    { label: t('ops.missions'), value: activeMissions, sub: `${queued} ${t('ops.queuedN')}` },
    {
      label: t('ops.openAlerts'),
      value: open,
      sub: t('ops.openAlerts.sub'),
      tone: open > 0 ? 'var(--color-crit)' : 'var(--color-ink)',
    },
    { label: t('ops.detections24h'), value: detections24h, sub: t('ops.detections24h.sub') },
    { label: t('ops.meanUplink'), value: rssi != null ? `${rssi}` : '—', sub: t('ops.meanUplink.sub') },
  ]
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5 md:gap-3">
      {tiles.map((tile, i) => (
        <Panel key={tile.label} className={`rise rise-${i + 1} px-3.5 py-3 ${i === 4 ? 'max-md:hidden' : ''}`}>
          <div className="microlabel">{tile.label}</div>
          <div className="mono mt-1.5 text-[26px] leading-none md:text-[30px]" style={{ color: tile.tone ?? 'var(--color-ink)' }}>
            {tile.value}
          </div>
          {tile.sub && <div className="mono mt-1 text-[10.5px] text-ink-3">{tile.sub}</div>}
        </Panel>
      ))}
    </div>
  )
}

function FleetStrip() {
  const robots = useApp((s) => s.robots)
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 md:gap-3">
      {robots.map((r) => (
        <FleetCell key={r.id} r={r} />
      ))}
    </div>
  )
}

function FleetCell({ r }: { r: RobotSpec }) {
  const tel = useApp((s) => s.telemetry[r.id])
  const missions = useApp((s) => s.missions)
  const history = useHistory(r.id)
  const nav = useNavigate()
  const t = useT()
  const m = tel?.missionId ? missions.find((x) => x.id === tel.missionId) : undefined
  return (
    <Panel className="panel-hover cursor-pointer p-3" onClick={() => nav(`/robots/${r.id}`)}>
      <div className="flex items-center gap-2">
        <span className="live-dot" style={{ background: r.color }} />
        <span className="mono text-[12.5px] font-medium tracking-[0.05em] text-ink">{r.callsign}</span>
        <span className="ml-auto">
          <ModeChip mode={tel?.mode} />
        </span>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <BatteryBar value={tel?.battery ?? 0} w={90} />
        <span className="mono text-[11px] text-ink-3">{tel?.speed?.toFixed(2) ?? '—'} m/s</span>
      </div>
      <div className="mt-2 truncate text-[12px] text-ink-3">
        {m ? (
          <>
            <span className="text-ink-2">{m.name}</span>
            <span className="mono"> · {Math.round(m.progress * 100)}%</span>
          </>
        ) : (
          t('c.noMission')
        )}
      </div>
      <div className="mt-2">
        <Spark points={history.slice(-70).map((h) => h.speed)} min={0} max={1.6} w={220} h={22} color={r.color} />
      </div>
    </Panel>
  )
}

function Feed() {
  const events = useApp((s) => s.events)
  const clock = useApp((s) => s.clock)
  const t = useT()
  const ago = useAgo()
  return (
    <Panel className="flex min-h-0 flex-col">
      <PanelHead
        label={t('ops.detections')}
        right={
          <Link to="/events" className="microlabel flex items-center gap-1 hover:text-ink-2">
            {t('ops.all')} <ArrowUpRight size={11} />
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {events.length === 0 && <EmptyNote>{t('ops.awaiting')}</EmptyNote>}
        {events.slice(0, 12).map((e) => (
          <div
            key={e.id}
            className={`flex items-center gap-2.5 border-b border-line/60 px-3.5 py-2 ${Date.now() - e.ts < 8000 ? 'flash-new' : ''} ${e.acked ? 'opacity-45' : ''}`}
          >
            <SevDot sev={e.severity} pulse={!e.acked && e.severity === 'critical'} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] leading-snug text-ink">{e.label}</div>
              <div className="microlabel mt-0.5 truncate">{e.zone}</div>
            </div>
            {e.snapshot && <img src={e.snapshot} alt="" loading="lazy" className="h-8 shrink-0 border border-line object-cover" style={{ width: 52 }} />}
            <span className="mono w-12 shrink-0 text-right text-[10.5px] text-ink-3">{ago(e.ts, clock)}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function MissionLog() {
  const missions = useApp((s) => s.missions)
  const robots = useApp((s) => s.robots)
  const t = useT()
  const ago = useAgo()
  const active = missions.filter((m) => m.status === 'active')
  const recentResults = useMemo(
    () =>
      missions
        .flatMap((m) => m.results.map((r) => ({ ...r, mission: m })))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 5),
    [missions],
  )
  const clock = useApp((s) => s.clock)
  return (
    <Panel className="flex min-h-0 flex-col">
      <PanelHead
        label={t('ops.missionOps')}
        right={
          <Link to="/missions" className="microlabel flex items-center gap-1 hover:text-ink-2">
            {t('ops.control')} <ArrowUpRight size={11} />
          </Link>
        }
      />
      <div className="space-y-2.5 border-b border-line/70 p-3.5">
        {active.length === 0 && <span className="text-[12.5px] text-ink-3">{t('ops.noActiveMissions')}</span>}
        {active.map((m) => {
          const r = robots.find((x) => x.id === m.robotId)
          return (
            <div key={m.id}>
              <div className="flex items-center gap-2">
                <span className="mono text-[11px] text-ink-3">{r?.callsign ?? '—'}</span>
                <span className="truncate text-[12.5px] text-ink-2">{m.name}</span>
                <span className="mono ml-auto text-[10.5px] text-ink-3">
                  {m.currentStep}/{m.steps.length}
                </span>
              </div>
              <div className="mt-1 h-[3px] bg-surface-3">
                <div className="h-full bg-ink/70 transition-[width] duration-700" style={{ width: `${m.progress * 100}%` }} />
              </div>
            </div>
          )
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {recentResults.map((r, i) => (
          <div key={`${r.mission.id}-${r.ts}-${i}`} className="flex items-center gap-2 border-b border-line/50 px-3.5 py-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: r.ok ? 'var(--color-ok)' : 'var(--color-warn)' }} />
            <span className="mono shrink-0 text-[10.5px] text-ink-3">{r.waypointId}</span>
            <span className="truncate text-[12px] text-ink-2">{r.note}</span>
            <span className="mono ml-auto w-10 shrink-0 text-right text-[10px] text-ink-3">{ago(r.ts, clock)}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function VideoQuick() {
  const cameras = useApp((s) => s.cameras)
  const nav = useNavigate()
  const picks = cameras.slice(0, 2)
  return (
    <div className="grid grid-cols-2 gap-2 md:gap-3">
      {picks.map((c) => (
        <button key={c.id} onClick={() => nav(`/live?src=${c.stream}`)} className="group relative aspect-video overflow-hidden border border-line transition-colors hover:border-line-2">
          <VideoThumb file={c.file} className="h-full w-full object-cover opacity-75 transition-opacity group-hover:opacity-100" />
          <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-black/60 px-2 py-1">
            {c.live && <Radio size={9} className="text-ok" />}
            <span className="mono truncate text-[10px] tracking-[0.06em] text-white/85">{c.name}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

export function Overview() {
  const [sel, setSel] = useState<MapSel>(null)
  const missions = useApp((s) => s.missions)
  const t = useT()
  const nav = useNavigate()
  const active = missions.filter((m) => m.status === 'active').length

  // dashboard map is a launchpad: robots open their detail, events open the board
  const onMapSelect = (s: MapSel) => {
    if (s?.kind === 'robot') nav(`/robots/${s.id}`)
    else if (s?.kind === 'event') nav('/events')
    else setSel(s)
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-3 p-3 md:p-4">
      <KpiRow />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <div className="space-y-3 lg:col-span-8">
          <Panel className="rise rise-2">
            <PanelHead label={`${active} ${t('ops.liveOperations.hint')}`} />
            <OpsMap selection={sel} onSelect={onMapSelect} heightClass="h-[340px] md:h-[460px]" className="border-0" wheelZoom={false} />
          </Panel>
          <FleetStrip />
        </div>
        <div className="flex flex-col gap-3 lg:col-span-4">
          <div className="min-h-[220px] flex-1">
            <Feed />
          </div>
          <div className="min-h-[200px] flex-1">
            <MissionLog />
          </div>
          <VideoQuick />
        </div>
      </div>
    </div>
  )
}
