import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Plus, X, Camera, Flame, Radar, Wind, AudioWaveform, Compass, ScanEye, Dog, Car } from 'lucide-react'
import { useApp } from '../lib/store'
import { Panel, PanelHead, Stat, BatteryBar, ModeChip } from '../components/ui'
import { SnapshotImg } from '../components/StreamPlayer'
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

const KIND_LABEL: Record<PayloadSpec['kind'], string> = {
  camera: 'Optical',
  thermal: 'Thermal',
  ogi: 'OGI',
  lidar: 'LiDAR',
  gas: 'Gas',
  acoustic: 'Acoustic',
  imu: 'IMU',
}

function ConnectModal({ onClose }: { onClose: () => void }) {
  const [queued, setQueued] = useState(false)
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 backdrop-blur-sm md:items-center" onClick={onClose}>
      <div className="panel w-full md:max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="microlabel">Provision new robot</span>
          <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="close">
            <X size={16} />
          </button>
        </div>
        {queued ? (
          <div className="space-y-2 p-6 text-center">
            <div className="mono text-[13px] text-ok">PROVISIONING QUEUED</div>
            <div className="text-[12px] text-ink-2">
              Discovery broadcast sent on 10.7.31.0/24. The unit will appear in the fleet once its DDS
              participant answers.
            </div>
          </div>
        ) : (
          <div className="space-y-3.5 p-4">
            {[
              ['Adapter', 'DeepRobotics · Clearpath · generic ROS2'],
              ['Transport', 'ROS2 / DDS discovery'],
              ['Video', 'RTSP → go2rtc relay (auto)'],
              ['Map share', 'align to yard-07 occupancy frame'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between border-b border-line/60 pb-2.5">
                <span className="microlabel">{k}</span>
                <span className="mono text-[11px] text-ink-2">{v}</span>
              </div>
            ))}
            <div>
              <div className="microlabel mb-1.5">Robot address</div>
              <input
                className="mono w-full border border-line-2 bg-surface-2 px-2.5 py-2 text-[12px] text-ink outline-none transition-colors focus:border-ink-3"
                placeholder="10.7.31.__"
                inputMode="decimal"
              />
            </div>
            <div>
              <div className="microlabel mb-1.5">Auth token</div>
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
              START DISCOVERY
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
  const cam = r.payloads.find((p) => p.stream)
  const m = tel?.missionId ? missions.find((x) => x.id === tel.missionId) : undefined

  return (
    <Panel className="panel-hover cursor-pointer" onClick={() => nav(`/robots/${r.id}`)}>
      <div className="relative h-32 overflow-hidden border-b border-line">
        {cam && (
          <SnapshotImg
            src={`/stream/api/frame.jpeg?src=${cam.stream}`}
            refreshMs={25000}
            className="h-full w-full object-cover opacity-60 grayscale-[0.35]"
            alt={r.model}
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/20 to-transparent" />
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
          <span className="microlabel shrink-0">Mission</span>
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
  const [connect, setConnect] = useState(false)

  const groups = useMemo(
    () => [
      { key: 'quadruped', label: 'Quadruped units', icon: Dog, list: robots.filter((r) => r.family === 'quadruped') },
      { key: 'ugv', label: 'Wheeled UGV', icon: Car, list: robots.filter((r) => r.family === 'ugv') },
    ],
    [robots],
  )

  const kinds: PayloadSpec['kind'][] = ['camera', 'thermal', 'ogi', 'gas', 'acoustic', 'lidar']

  return (
    <div className="mx-auto max-w-[1300px] space-y-4 p-3 md:p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="microlabel">Fleet</div>
          <div className="mono mt-0.5 text-[13px] text-ink-2">
            {robots.length} units · {Object.values(telemetry).filter((t) => t.mode !== 'idle').length} tasked
          </div>
        </div>
        <button
          onClick={() => setConnect(true)}
          className="mono flex items-center gap-1.5 border border-line px-2.5 py-1.5 text-[10.5px] tracking-[0.1em] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
        >
          <Plus size={13} /> CONNECT ROBOT
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
                <span className="microlabel">Provision unit</span>
              </button>
            )}
          </div>
        </div>
      ))}

      {/* sensor coverage matrix */}
      <Panel className="rise rise-3">
        <PanelHead label="Sensor coverage matrix" right={<span className="mono text-[10px] text-ink-3">payload × unit</span>} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className="microlabel px-3.5 py-2 text-left font-medium">Unit</th>
                {kinds.map((k) => {
                  const Icon = KIND_ICON[k]
                  return (
                    <th key={k} className="px-2 py-2">
                      <div className="flex flex-col items-center gap-1">
                        <Icon size={13} strokeWidth={1.5} className="text-ink-3" />
                        <span className="microlabel">{KIND_LABEL[k]}</span>
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
          <span className="mono text-[9.5px] text-ink-3">◉ streaming payload</span>
          <span className="mono text-[9.5px] text-ink-3">● telemetry payload</span>
        </div>
      </Panel>

      {connect && <ConnectModal onClose={() => setConnect(false)} />}
    </div>
  )
}
