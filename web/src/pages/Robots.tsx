import { Suspense, lazy, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Plus, X, Camera, Flame, Radar, Wind, AudioWaveform, Compass, ScanEye, Dog, Car } from 'lucide-react'
import { useApp } from '../lib/store'
import { useT } from '../lib/i18n'
import { Panel, PanelHead, BatteryBar, ModeChip } from '../components/ui'
const RobotThumb = lazy(() => import('../three/RobotThumb').then((m) => ({ default: m.RobotThumb })))
import type { PayloadSpec, RobotSpec } from '../lib/types'

export const KIND_ICON: Record<PayloadSpec['kind'], any> = {
  camera: Camera,
  thermal: Flame,
  ogi: ScanEye,
  lidar: Radar,
  gas: Wind,
  acoustic: AudioWaveform,
  imu: Compass,
}

const KIND_KEY: Record<string, string> = {
  camera: 'fl.k.optical',
  thermal: 'fl.k.thermal',
  ogi: 'fl.k.ogi',
  gas: 'fl.k.gas',
  acoustic: 'fl.k.acoustic',
  lidar: 'fl.k.lidar',
}

function ConnectModal({ onClose }: { onClose: () => void }) {
  const [queued, setQueued] = useState(false)
  const t = useT()
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 backdrop-blur-sm md:items-center" onClick={onClose}>
      <div className="panel w-full md:max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="microlabel">{t('fl.modal.title')}</span>
          <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="close">
            <X size={16} />
          </button>
        </div>
        {queued ? (
          <div className="space-y-2 p-6 text-center">
            <div className="mono text-[13px] text-ok">{t('fl.modal.queued')}</div>
            <div className="text-[12px] text-ink-2">{t('fl.modal.queuedDesc')}</div>
          </div>
        ) : (
          <div className="space-y-3.5 p-4">
            {[
              [t('fl.modal.adapter'), 'DeepRobotics · Clearpath · generic ROS2'],
              [t('fl.modal.transport'), 'ROS2 / DDS discovery'],
              [t('fl.modal.video'), 'RTSP → go2rtc relay (auto)'],
              [t('fl.modal.mapShare'), 'align to yard-07 occupancy frame'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between border-b border-line/60 pb-2.5">
                <span className="microlabel">{k}</span>
                <span className="mono text-[11px] text-ink-2">{v}</span>
              </div>
            ))}
            <div>
              <div className="microlabel mb-1.5">{t('fl.modal.addr')}</div>
              <input
                className="mono w-full border border-line-2 bg-surface-2 px-2.5 py-2 text-[12px] text-ink outline-none transition-colors focus:border-ink-3"
                placeholder="10.7.31.__"
                inputMode="decimal"
              />
            </div>
            <div>
              <div className="microlabel mb-1.5">{t('fl.modal.token')}</div>
              <input
                className="mono w-full border border-line-2 bg-surface-2 px-2.5 py-2 text-[12px] text-ink outline-none transition-colors focus:border-ink-3"
                placeholder="drs_••••••••"
                type="password"
              />
            </div>
            <button
              onClick={() => setQueued(true)}
              className="mono w-full border border-ink/30 bg-ink/10 px-3 py-2 text-[11px] tracking-[0.12em] text-ink transition-colors hover:bg-ink/15"
            >
              {t('fl.modal.start')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function RobotCard({ r }: { r: RobotSpec }) {
  const tel = useApp((s) => s.telemetry[r.id])
  const missions = useApp((s) => s.missions)
  const nav = useNavigate()
  const t = useT()
  const m = tel?.missionId ? missions.find((x) => x.id === tel.missionId) : undefined

  return (
    <Panel className="panel-hover cursor-pointer" onClick={() => nav(`/robots/${r.id}`)}>
      <div className="relative h-44 overflow-hidden border-b border-line">
        <Suspense fallback={<div className="skeleton absolute inset-0 opacity-20" />}>
          <RobotThumb urdf={r.urdf} className="absolute inset-0" />
        </Suspense>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-bg/85 to-transparent" />
        <div className="absolute bottom-2.5 left-3 flex items-center gap-2.5">
          <span className="live-dot" style={{ background: r.color }} />
          <span className="mono text-[13px] font-medium tracking-[0.05em] text-ink">{r.callsign}</span>
          <span className="microlabel">{r.model}</span>
        </div>
        <div className="absolute right-2.5 top-2.5">
          <ModeChip mode={tel?.mode} />
        </div>
      </div>
      <div className="space-y-3 p-3.5">
        <div className="flex items-center justify-between">
          <BatteryBar value={tel?.battery ?? 0} w={130} />
          <span className="mono text-[10px] text-ink-3">{tel?.speed.toFixed(2) ?? '—'} m/s</span>
        </div>
        <div className="flex items-center gap-2 border-t border-line/70 pt-2.5">
          <span className="microlabel shrink-0">{t('c.mission')}</span>
          {m ? (
            <>
              <span className="truncate text-[11.5px] text-ink-2">{m.name}</span>
              <span className="mono ml-auto shrink-0 text-[10px] text-ink-3">{Math.round(m.progress * 100)}%</span>
            </>
          ) : (
            <span className="text-[11.5px] text-ink-3">—</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 border-t border-line/70 pt-2.5">
          {r.payloads.map((p) => {
            const Icon = KIND_ICON[p.kind]
            return (
              <span
                key={p.id}
                title={`${p.name} · ${p.model}`}
                className="flex h-6 w-6 items-center justify-center border border-line text-ink-3"
                style={p.stream ? { color: 'var(--color-ink-2)', borderColor: 'var(--color-line-2)' } : undefined}
              >
                <Icon size={12} strokeWidth={1.5} />
              </span>
            )
          })}
          <span className="mono ml-auto text-[9.5px] text-ink-3">
            {r.ipRating} · {r.massKg} kg
          </span>
        </div>
      </div>
    </Panel>
  )
}

export function Robots() {
  const robots = useApp((s) => s.robots)
  const telemetry = useApp((s) => s.telemetry)
  const t = useT()
  const [connect, setConnect] = useState(false)

  const groups = useMemo(
    () => [
      { key: 'quadruped', label: t('fl.quadruped'), icon: Dog, list: robots.filter((r) => r.family === 'quadruped') },
      { key: 'ugv', label: t('fl.ugv'), icon: Car, list: robots.filter((r) => r.family === 'ugv') },
    ],
    [robots, t],
  )

  const kinds: PayloadSpec['kind'][] = ['camera', 'thermal', 'ogi', 'gas', 'acoustic', 'lidar']

  return (
    <div className="mx-auto max-w-[1300px] space-y-4 p-3 md:p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="microlabel">{t('fl.fleet')}</div>
          <div className="mono mt-0.5 text-[13px] text-ink-2">
            {robots.length} {t('c.units')} · {Object.values(telemetry).filter((x) => x.mode !== 'idle').length} {t('c.tasked')}
          </div>
        </div>
        <button
          onClick={() => setConnect(true)}
          className="mono flex items-center gap-1.5 border border-line px-2.5 py-1.5 text-[10.5px] tracking-[0.1em] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
        >
          <Plus size={13} /> {t('fl.connectRobot')}
        </button>
      </div>

      {groups.map((g, gi) => (
        <div key={g.key} className={`rise rise-${gi + 1}`}>
          <div className="mb-2 flex items-center gap-2">
            <g.icon size={13} strokeWidth={1.5} className="text-ink-3" />
            <span className="microlabel">{g.label}</span>
            <span className="mono text-[10px] text-ink-3">{g.list.length}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {g.list.map((r) => (
              <RobotCard key={r.id} r={r} />
            ))}
            {g.key === 'ugv' && (
              <button
                onClick={() => setConnect(true)}
                className="flex min-h-[180px] flex-col items-center justify-center gap-2 border border-dashed border-line-2 text-ink-3 transition-colors hover:border-ink-3 hover:text-ink-2"
              >
                <Plus size={18} strokeWidth={1.5} />
                <span className="microlabel">{t('fl.provision')}</span>
              </button>
            )}
          </div>
        </div>
      ))}

      {/* sensor coverage matrix */}
      <Panel className="rise rise-3">
        <PanelHead label={t('fl.matrix')} right={<span className="mono text-[10px] text-ink-3">{t('fl.matrix.sub')}</span>} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className="microlabel px-3.5 py-2 text-left font-medium">{t('fl.unit')}</th>
                {kinds.map((k) => {
                  const Icon = KIND_ICON[k]
                  return (
                    <th key={k} className="px-2 py-2">
                      <div className="flex flex-col items-center gap-1">
                        <Icon size={13} strokeWidth={1.5} className="text-ink-3" />
                        <span className="microlabel">{t(KIND_KEY[k])}</span>
                      </div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {robots.map((r) => (
                <tr key={r.id} className="border-b border-line/60 last:border-0">
                  <td className="px-3.5 py-2.5">
                    <div className="flex items-center gap-2">
                      <span style={{ width: 5, height: 5, borderRadius: r.family === 'ugv' ? 1 : 99, background: r.color, display: 'inline-block' }} />
                      <span className="mono text-[11.5px] text-ink">{r.callsign}</span>
                      <span className="microlabel hidden sm:inline">{r.family}</span>
                    </div>
                  </td>
                  {kinds.map((k) => {
                    const p = r.payloads.find((x) => x.kind === k)
                    return (
                      <td key={k} className="px-2 py-2.5 text-center">
                        {p ? (
                          <span title={`${p.name} · ${p.model}`} className="mono text-[11px]" style={{ color: p.stream ? 'var(--color-ink)' : 'var(--color-ink-2)' }}>
                            {p.stream ? '◉' : '●'}
                          </span>
                        ) : (
                          <span className="text-[11px] text-ink-3/40">—</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-4 border-t border-line px-3.5 py-2">
          <span className="mono text-[9.5px] text-ink-3">{t('fl.streaming')}</span>
          <span className="mono text-[9.5px] text-ink-3">{t('fl.telemetry')}</span>
        </div>
      </Panel>

      {connect && <ConnectModal onClose={() => setConnect(false)} />}
    </div>
  )
}
