import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, ArrowUpRight } from 'lucide-react'
import { useApp, useHistory } from '../lib/store'
import { useT } from '../lib/i18n'
import { Panel, PanelHead, Stat, Spark, BatteryBar, ModeChip } from '../components/ui'
import { RobotViewer } from '../three/RobotViewer'
import { KIND_ICON } from './Robots'

function JointRow({ name, c }: { name: string; c: number }) {
  const tone = c > 55 ? 'var(--color-crit)' : c > 50 ? 'var(--color-warn)' : 'var(--color-ink-2)'
  return (
    <div className="flex items-center gap-2.5 px-3.5 py-[7px]">
      <span className="mono w-16 shrink-0 text-[10.5px] text-ink-3">{name}</span>
      <div className="h-[3px] flex-1 overflow-hidden bg-surface-3">
        <div
          className="h-full transition-[width] duration-500"
          style={{ width: `${Math.min(100, ((c - 30) / 40) * 100)}%`, background: tone, opacity: 0.7 }}
        />
      </div>
      <span className="mono w-12 shrink-0 text-right text-[10.5px]" style={{ color: tone }}>
        {c.toFixed(1)}°C
      </span>
    </div>
  )
}

export function RobotDetail() {
  const { id } = useParams()
  const robot = useApp((s) => s.robots.find((r) => r.id === id))
  const tel = useApp((s) => (id ? s.telemetry[id] : undefined))
  const missions = useApp((s) => s.missions)
  const waypoints = useApp((s) => s.waypoints)
  const history = useHistory(id)
  const t = useT()
  const [payloadSel, setPayloadSel] = useState<string | null>(null)

  const mission = tel?.missionId ? missions.find((m) => m.id === tel.missionId) : undefined
  const targetWp = tel?.targetWp ? waypoints.find((w) => w.id === tel.targetWp) : undefined

  const identity = useMemo(
    () =>
      robot
        ? ([
            [t('rd.serial'), robot.serial],
            [t('rd.firmware'), robot.firmware],
            [t('rd.address'), robot.ip],
            [t('rd.uplink'), robot.protocol],
            [t('rd.mass'), `${robot.massKg} kg`],
            [t('rd.ingress'), robot.ipRating],
            [t('rd.maxSpeed'), `${robot.maxSpeed} m/s`],
            [t('rd.endurance'), `${robot.enduranceMin} min`],
          ] as [string, string][])
        : [],
    [robot, t],
  )

  if (!robot)
    return (
      <div className="p-6">
        <div className="microlabel">{t('rd.unknown')}</div>
      </div>
    )

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 p-3 md:p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/robots" className="text-ink-3 transition-colors hover:text-ink">
            <ArrowLeft size={16} />
          </Link>
          <div>
            <div className="microlabel">
              {robot.vendor} · {robot.model}
            </div>
            <div className="mt-0.5 flex items-center gap-2.5">
              <span className="live-dot" style={{ background: robot.color }} />
              <span className="mono text-[15px] font-medium tracking-[0.04em] text-ink">{robot.callsign}</span>
              <ModeChip mode={tel?.mode} />
            </div>
          </div>
        </div>
        <Link
          to={`/map?sel=${robot.id}`}
          className="microlabel hidden items-center gap-1 border border-line px-2.5 py-1.5 transition-colors hover:border-line-2 hover:text-ink-2 md:flex"
        >
          {t('rd.locate')} <ArrowUpRight size={11} />
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        {/* 3D viewer */}
        <Panel className="relative h-[44vh] min-h-[300px] overflow-hidden lg:col-span-7 lg:h-[calc(100vh-190px)] lg:max-h-[720px]">
          <div className="absolute inset-0">
            <RobotViewer
              urdf={robot.urdf}
              family={robot.family}
              gait={tel?.gait}
              speed={tel?.speed}
              payloads={robot.payloads}
              highlight={payloadSel}
              onPick={setPayloadSel}
            />
          </div>
          <div className="pointer-events-none absolute left-3 top-3">
            <span className="microlabel">{t('rd.digitalTwin')}</span>
          </div>
        </Panel>

        {/* right column */}
        <div className="space-y-3 lg:col-span-5">
          <Panel className="rise">
            <PanelHead label={t('rd.status')} right={<span className="mono text-[10px] text-ink-3">{tel ? '4 Hz' : t('c.noData')}</span>} />
            <div className="space-y-4 p-3.5">
              {mission && (
                <div className="flex items-center gap-2 border border-line bg-surface-2 px-2.5 py-2">
                  <span className="live-dot shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-ink">{mission.name}</div>
                    <div className="microlabel mt-0.5">
                      {targetWp ? `→ ${targetWp.id} ${targetWp.name}` : `${t('rd.step')} ${mission.currentStep + 1}/${mission.steps.length}`}
                      {tel?.pathRemaining ? ` · ${tel.pathRemaining} ${t('rd.mLeft')}` : ''}
                    </div>
                  </div>
                  <span className="mono shrink-0 text-[11px] text-ink-2">{Math.round(mission.progress * 100)}%</span>
                </div>
              )}
              <div className="flex items-end justify-between gap-4">
                <div className="flex-1">
                  <div className="microlabel mb-1.5">{t('c.battery')}</div>
                  <BatteryBar value={tel?.battery ?? 0} w={150} />
                </div>
                <Stat label={t('rd.gait')} value={tel?.gait ?? '—'} />
              </div>
              <div className="grid grid-cols-4 gap-3">
                <Stat label={t('c.speed')} value={tel?.speed.toFixed(2) ?? '—'} unit="m/s" />
                <Stat label={t('c.link')} value={tel?.rssi ?? '—'} unit="dBm" />
                <Stat label="RTT" value={tel?.latency ?? '—'} unit="ms" />
                <Stat label={t('rd.odom')} value={tel?.odoKm.toFixed(1) ?? '—'} unit="km" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="microlabel mb-1">{t('rd.speed40')}</div>
                  <Spark points={history.slice(-80).map((h) => h.speed)} min={0} max={1.6} w={200} h={30} color="var(--color-ink-2)" />
                </div>
                <div>
                  <div className="microlabel mb-1">{t('rd.link40')}</div>
                  <Spark points={history.slice(-80).map((h) => h.rssi)} min={-70} max={-40} w={200} h={30} color="var(--color-ink-3)" />
                </div>
              </div>
            </div>
          </Panel>

          <Panel className="rise rise-1">
            <PanelHead label={t('rd.payloads')} right={<span className="mono text-[10px] text-ink-3">{robot.payloads.length} {t('rd.fitted')}</span>} />
            {robot.payloads.map((p) => {
              const Icon = KIND_ICON[p.kind]
              const hot = payloadSel === p.id
              return (
                <button
                  key={p.id}
                  onClick={() => setPayloadSel(hot ? null : p.id)}
                  className={`flex w-full items-start gap-3 border-b border-line/60 px-3.5 py-3 text-left transition-colors ${
                    hot ? 'bg-surface-2' : 'hover:bg-surface-2/60'
                  }`}
                  style={hot ? { boxShadow: 'inset 2px 0 0 var(--color-ink)' } : undefined}
                >
                  <Icon size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" style={{ color: hot ? 'var(--color-ink)' : 'var(--color-ink-3)' }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] text-ink">{p.name}</span>
                      {p.stream && (
                        <Link
                          to={`/live?src=${p.stream}`}
                          onClick={(e) => e.stopPropagation()}
                          className="mono flex items-center gap-1 border border-ok/30 bg-ok/10 px-1 py-0.5 text-[8.5px] tracking-[0.12em] text-ok hover:bg-ok/20"
                        >
                          <span className="live-dot" style={{ width: 4, height: 4, background: 'var(--color-ok)' }} />
                          {t('live.live')}
                        </Link>
                      )}
                    </div>
                    <div className="mono mt-0.5 text-[10.5px] text-ink-3">{p.model}</div>
                    <div className="mt-0.5 text-[11px] text-ink-2">{p.detail}</div>
                  </div>
                  <span
                    className="mono mt-1 shrink-0 text-[9px] uppercase tracking-[0.1em]"
                    style={{ color: (tel?.payloadHealth[p.id] ?? 'ok') === 'ok' ? 'var(--color-ok)' : 'var(--color-warn)' }}
                  >
                    {tel?.payloadHealth[p.id] ?? 'ok'}
                  </span>
                </button>
              )
            })}
          </Panel>

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <Panel className="rise rise-2">
              <PanelHead label={robot.family === 'ugv' ? t('rd.driveThermals') : t('rd.jointThermals')} />
              <div className="py-1">
                {(tel?.joints ?? []).map((j) => (
                  <JointRow key={j.name} name={j.name} c={j.c} />
                ))}
                {!tel && <div className="px-3.5 py-3 text-[11px] text-ink-3">{t('rd.awaitingTel')}</div>}
              </div>
            </Panel>
            <Panel className="rise rise-3">
              <PanelHead label={t('rd.identity')} />
              <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 p-3.5 xl:grid-cols-1 xl:gap-y-3">
                {identity.map(([k, v]) => (
                  <div key={k}>
                    <div className="microlabel mb-0.5">{k}</div>
                    <div className="mono truncate text-[11px] text-ink-2">{v}</div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  )
}
