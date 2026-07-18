import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { useApp } from '../lib/store'
import { useT, useAgo } from '../lib/i18n'
import { OpsMap, type MapSel } from '../components/OpsMap'
import { BatteryBar, SevTag, Panel, ModeChip } from '../components/ui'

function SelectionCard({ sel }: { sel: MapSel }) {
  const robots = useApp((s) => s.robots)
  const telemetry = useApp((s) => s.telemetry)
  const events = useApp((s) => s.events)
  const waypoints = useApp((s) => s.waypoints)
  const missions = useApp((s) => s.missions)
  const clock = useApp((s) => s.clock)
  const t = useT()
  const ago = useAgo()
  if (!sel) return null

  if (sel.kind === 'robot') {
    const r = robots.find((x) => x.id === sel.id)
    const tel = telemetry[sel.id]
    if (!r) return null
    const m = tel?.missionId ? missions.find((x) => x.id === tel.missionId) : undefined
    return (
      <Panel className="pointer-events-auto w-full max-w-[400px] p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="live-dot" style={{ background: r.color }} />
            <span className="mono text-[13px] font-medium tracking-[0.05em] text-ink">{r.callsign}</span>
            <ModeChip mode={tel?.mode} />
          </div>
          <Link
            to={`/robots/${r.id}`}
            className="mono flex items-center gap-1 border border-line-2 px-1.5 py-1 text-[10px] tracking-[0.1em] text-ink-3 transition-colors hover:text-ink-2"
          >
            {t('c.detail')} <ArrowUpRight size={10} />
          </Link>
        </div>
        {m && (
          <div className="mt-2.5 flex items-center gap-2 border-t border-line/70 pt-2.5">
            <span className="microlabel shrink-0">{t('c.mission')}</span>
            <span className="truncate text-[13px] text-ink-2">{m.name}</span>
            <span className="mono ml-auto shrink-0 text-[11px] text-ink-3">
              {m.currentStep}/{m.steps.length} · {Math.round(m.progress * 100)}%
            </span>
          </div>
        )}
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <BatteryBar value={tel?.battery ?? 0} w={100} />
          <span className="mono text-[11.5px] text-ink-2">{tel?.speed.toFixed(2) ?? '—'} m/s</span>
          <span className="mono text-[11.5px] text-ink-2">{tel?.rssi ?? '—'} dBm</span>
          <span className="mono text-[11.5px] text-ink-3">
            x{tel?.x.toFixed(1) ?? '—'} z{tel?.z.toFixed(1) ?? '—'}
          </span>
        </div>
      </Panel>
    )
  }

  if (sel.kind === 'waypoint') {
    const wp = waypoints.find((w) => w.id === sel.id)
    if (!wp) return null
    return (
      <Panel className="pointer-events-auto w-full max-w-[400px] p-3.5">
        <div className="flex items-center gap-2.5">
          <span className="mono text-[13px] text-ink">{wp.id}</span>
          <span className="text-[13px] text-ink-2">{wp.name}</span>
          <span className="microlabel ml-auto">{wp.kind}</span>
        </div>
        <div className="mono mt-1.5 text-[11.5px] text-ink-3">
          x {wp.x.toFixed(1)} · z {wp.z.toFixed(1)} — {t('map.wpDispatch')}
        </div>
      </Panel>
    )
  }

  const ev = events.find((e) => e.id === sel.id)
  if (!ev) return null
  return (
    <Panel className="pointer-events-auto w-full max-w-[400px] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SevTag sev={ev.severity} />
            <span className="mono text-[11px] text-ink-3">{ago(ev.ts, clock)}</span>
            <Link
              to={`/events?ev=${ev.id}`}
              className="mono flex items-center gap-1 border border-line-2 px-1.5 py-1 text-[10px] tracking-[0.1em] text-ink-3 transition-colors hover:text-ink-2"
            >
              {t('c.detail')} <ArrowUpRight size={10} />
            </Link>
          </div>
          <div className="mt-1.5 text-[14px] text-ink">{ev.label}</div>
          <div className="microlabel mt-1">
            {ev.zone} · {ev.sourceName}
          </div>
        </div>
        {ev.snapshot && <img src={ev.snapshot} alt="" className="h-14 w-24 shrink-0 border border-line object-cover" />}
      </div>
    </Panel>
  )
}

export function MapPage() {
  const robots = useApp((s) => s.robots)
  const site = useApp((s) => s.site)
  const [sel, setSel] = useState<MapSel>(() => {
    const id = new URLSearchParams(location.search).get('sel')
    return id ? { kind: 'robot', id } : null
  })

  return (
    <div className="relative h-full min-h-[420px]">
      <div className="absolute inset-0">
        <OpsMap selection={sel} onSelect={setSel} heightClass="h-full" className="border-0 bg-transparent" />
      </div>

      {/* top-left: site + fleet chips */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 space-y-2">
        <div className="text-[14px] font-medium text-ink">{site?.name ?? '—'}</div>
        <div className="pointer-events-auto flex flex-wrap gap-1.5">
          {robots.map((r) => {
            const active = sel?.kind === 'robot' && sel.id === r.id
            return (
              <button
                key={r.id}
                onClick={() => setSel(active ? null : { kind: 'robot', id: r.id })}
                className={`mono flex items-center gap-1.5 border px-2 py-1 text-[11px] tracking-[0.08em] backdrop-blur transition-colors ${
                  active ? 'border-(--signal) bg-(--signal) text-[#080808]' : 'border-line bg-bg/60 text-ink-2 hover:border-line-2'
                }`}
              >
                <span style={{ width: 5, height: 5, borderRadius: r.family === 'ugv' ? 1 : 99, background: r.color, display: 'inline-block' }} />
                {r.callsign}
              </button>
            )
          })}
        </div>
      </div>

      {/* bottom: selection card */}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex justify-center md:justify-start">
        <SelectionCard sel={sel} />
      </div>
    </div>
  )
}
