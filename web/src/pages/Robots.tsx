import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Plus, X, Camera, Flame, Radar, Wind, AudioWaveform, Compass, ScanEye, Dog, Car, Check, PawPrint, Truck } from 'lucide-react'
import { useApp, api, useCan } from '../lib/store'
import { useT, useLang, IDX } from '../lib/i18n'
import { Panel, PanelHead, BatteryBar, ModeChip, Modal } from '../components/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
const RobotThumb = lazy(() => import('../three/RobotThumb').then((m) => ({ default: m.RobotThumb })))
import type { PayloadSpec, RobotModelSpec, RobotSpec } from '../lib/types'

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

/** family silhouette shown when a model has no URDF twin yet */
export function TwinPlaceholder({ family, label }: { family: 'quadruped' | 'ugv'; label?: string }) {
  const Icon = family === 'ugv' ? Truck : PawPrint
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-ink-3">
      <Icon size={30} strokeWidth={1} />
      {label && <span className="microlabel">{label}</span>}
    </div>
  )
}

function ProvisionWizard({ onClose }: { onClose: () => void }) {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const li = IDX[lang]
  const nav = useNavigate()
  const waypoints = useApp((s) => s.waypoints)
  const robots = useApp((s) => s.robots)

  const [models, setModels] = useState<RobotModelSpec[]>([])
  const [payloads, setPayloads] = useState<PayloadSpec[]>([])
  useEffect(() => {
    api.getCatalog().then((c) => {
      setModels(c.models ?? [])
      setPayloads(c.payloads ?? [])
    })
  }, [])

  const [step, setStep] = useState(0)
  const [model, setModel] = useState<RobotModelSpec | null>(null)
  const [callsign, setCallsign] = useState('')
  const [ip, setIp] = useState(() => `10.7.31.${60 + Math.floor(Math.random() * 30)}`)
  const [protocol, setProtocol] = useState('')
  const [homeWp, setHomeWp] = useState('WP-09')
  const [picked, setPicked] = useState<string[]>(['ptz-4mp', 'lidar-m360'])
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<RobotSpec | null>(null)

  const suggestion = useMemo(() => {
    if (!model) return ''
    const code = model.model.includes('Lite3') ? 'L3' : model.model.includes('X30') ? 'X30' : model.model.includes('M20') ? 'M20' : 'HSK'
    const n = robots.filter((r) => r.model === model.model).length + 1
    return `${model.vendor.startsWith('DEEP') ? 'JY·' : ''}${code}-${String(n).padStart(2, '0')}`
  }, [model, robots])

  const submit = async () => {
    if (!model || busy) return
    setBusy(true)
    const wp = waypoints.find((w) => w.id === homeWp)
    const res = await api.registerRobot({
      model: model.model,
      callsign: callsign || undefined,
      ip,
      protocol: protocol || undefined,
      home: wp ? { x: wp.x, z: wp.z } : { x: 0, z: 0 },
      payloadIds: picked,
    })
    setBusy(false)
    if (res.robot) setCreated(res.robot)
  }

  const steps = [t('fl.wiz.stepModel'), t('fl.wiz.stepLink'), t('fl.wiz.stepPayload')]

  return (
    <Modal onClose={onClose} wide title={t('fl.wiz.title')}>
      <div className="flex max-h-[86dvh] flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="microlabel">{t('fl.wiz.title')}</span>
          {!created && (
            <div className="mono hidden items-center gap-2 text-[11px] tracking-[0.1em] text-ink-3 sm:flex">
              {steps.map((s, i) => (
                <span key={s} className="flex items-center gap-2">
                  {i > 0 && <span className="h-px w-4 bg-line-2" />}
                  <span style={{ color: i === step ? 'var(--color-accent)' : i < step ? 'var(--color-ink-2)' : undefined }}>
                    {i + 1} {s.toUpperCase()}
                  </span>
                </span>
              ))}
            </div>
          )}
          <Button variant="ghost" size="iconSm" onClick={onClose} aria-label="close">
            <X size={16} />
          </Button>
        </div>

        {created ? (
          <div className="space-y-4 p-8 text-center">
            <div className="mono text-[14px] text-accent">{t('fl.wiz.done.title')}</div>
            <div className="mono text-[20px] text-ink">{created.callsign}</div>
            <div className="mx-auto max-w-sm text-[13px] text-ink-2">{t('fl.wiz.done.desc')}</div>
            <Button
              variant="signal"
              onClick={() => nav(`/robots/${created.id}`)}
              className="mono h-auto px-4 py-2 text-[12px] normal-case tracking-[0.12em]"
            >
              {t('fl.wiz.viewUnit')}
            </Button>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {step === 0 && (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {models.map((m) => {
                    const sel = model?.model === m.model
                    return (
                      <button
                        key={m.model}
                        onClick={() => {
                          setModel(m)
                          setProtocol(m.protocol)
                        }}
                        className="panel-hover border p-3 text-left"
                        style={{ borderColor: sel ? 'var(--color-accent)' : 'var(--color-line)' }}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[14px] font-medium text-ink">{m.model}</span>
                          {sel && <Check size={13} className="shrink-0 text-accent" />}
                        </div>
                        <div className="microlabel mt-0.5">{m.vendor}</div>
                        <div className="mono mt-2 text-[11.5px] text-ink-2">
                          {m.massKg} kg · {m.ipRating} · {m.maxSpeed} m/s · {m.enduranceMin} min
                        </div>
                        <div className="mt-1.5 text-[12px] leading-snug text-ink-3">{m.blurb[li]}</div>
                      </button>
                    )
                  })}
                </div>
              )}

              {step === 1 && model && (
                <div className="space-y-3.5">
                  <div className="flex items-center justify-between border-b border-line/60 pb-2.5">
                    <span className="microlabel">{t('fl.wiz.stepModel')}</span>
                    <span className="mono text-[12px] text-ink-2">
                      {model.model} · {model.firmware}
                    </span>
                  </div>
                  <div>
                    <Label className="mb-1.5">{t('fl.wiz.callsign')}</Label>
                    <Input className="mono bg-surface-2 py-2 text-[13px]" placeholder={suggestion} value={callsign} onChange={(e) => setCallsign(e.target.value)} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="mb-1.5">{t('fl.wiz.address')}</Label>
                      <Input className="mono bg-surface-2 py-2 text-[13px]" value={ip} onChange={(e) => setIp(e.target.value)} inputMode="decimal" />
                    </div>
                    <div>
                      <Label className="mb-1.5">{t('fl.wiz.transport')}</Label>
                      <Select value={protocol} onValueChange={setProtocol}>
                        <SelectTrigger className="mono w-full bg-surface-2 text-[12px] normal-case tracking-normal">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[model.protocol, 'ROS2 / DDS · Ethernet', 'MQTT bridge · 5G-U', 'REST poll · Wi-Fi'].map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <Label className="mb-1.5">{t('fl.wiz.home')}</Label>
                    <Select value={homeWp} onValueChange={setHomeWp}>
                      <SelectTrigger className="mono w-full bg-surface-2 text-[12px] normal-case tracking-normal">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {waypoints.map((w) => (
                          <SelectItem key={w.id} value={w.id}>
                            {w.id} · {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-3">
                  <div className="text-[12.5px] text-ink-3">{t('fl.wiz.payloadHint')}</div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {payloads.map((p) => {
                      const Icon = KIND_ICON[p.kind]
                      const sel = picked.includes(p.id)
                      return (
                        <button
                          key={p.id}
                          onClick={() => setPicked((cur) => (sel ? cur.filter((x) => x !== p.id) : [...cur, p.id]))}
                          className="panel-hover flex items-start gap-2.5 border p-2.5 text-left"
                          style={{ borderColor: sel ? 'var(--color-accent)' : 'var(--color-line)' }}
                        >
                          <Icon size={15} strokeWidth={1.5} className={sel ? 'mt-0.5 shrink-0 text-accent' : 'mt-0.5 shrink-0 text-ink-3'} />
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] text-ink">{p.name}</span>
                            <span className="mono mt-0.5 block truncate text-[11px] text-ink-3">{p.model}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-line px-4 py-3">
              <Button
                variant="ghost"
                onClick={() => (step === 0 ? onClose() : setStep(step - 1))}
                className="mono px-2 text-[11.5px] normal-case tracking-[0.1em]"
              >
                {step === 0 ? t('c.cancel') : t('fl.wiz.back')}
              </Button>
              <div className="flex items-center gap-3">
                {step === 2 && (
                  <span className="mono text-[11px] text-ink-3">
                    {picked.length} {t('fl.wiz.selected')}
                  </span>
                )}
                {step < 2 ? (
                  <Button
                    variant="outline"
                    disabled={!model}
                    onClick={() => setStep(step + 1)}
                    className="mono px-3.5 text-[11.5px] normal-case tracking-[0.12em] text-ink disabled:opacity-40"
                  >
                    {t('fl.wiz.next')}
                  </Button>
                ) : (
                  <Button
                    variant="signal"
                    onClick={submit}
                    disabled={busy}
                    className="mono px-3.5 text-[11.5px] normal-case tracking-[0.12em] hover:hover:disabled:opacity-50"
                  >
                    {busy ? t('fl.wiz.connecting') : t('fl.wiz.connect')}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
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
          {r.urdf ? (
            <RobotThumb urdf={r.urdf} className="absolute inset-0" />
          ) : (
            <TwinPlaceholder family={r.family} label={undefined} />
          )}
        </Suspense>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-bg/85 to-transparent" />
        <div className="absolute bottom-2.5 left-3 flex items-center gap-2.5">
          <span className="live-dot" style={{ background: r.color }} />
          <span className="mono text-[14px] font-medium tracking-[0.05em] text-ink">{r.callsign}</span>
          <span className="microlabel">{r.model}</span>
        </div>
        <div className="absolute right-2.5 top-2.5">
          <ModeChip mode={tel?.mode} />
        </div>
      </div>
      <div className="space-y-3 p-3.5">
        <div className="flex items-center justify-between">
          <BatteryBar value={tel?.battery ?? 0} w={130} />
          <span className="mono text-[11px] text-ink-3">{tel?.speed.toFixed(2) ?? '—'} m/s</span>
        </div>
        <div className="flex items-center gap-2 border-t border-line/70 pt-2.5">
          <span className="microlabel shrink-0">{t('c.mission')}</span>
          {m ? (
            <>
              <span className="truncate text-[12.5px] text-ink-2">{m.name}</span>
              <span className="mono ml-auto shrink-0 text-[11px] text-ink-3">{Math.round(m.progress * 100)}%</span>
            </>
          ) : (
            <span className="text-[12.5px] text-ink-3">—</span>
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
          <span className="mono ml-auto text-[10.5px] text-ink-3">
            {r.ipRating} · {r.massKg} kg
          </span>
        </div>
      </div>
    </Panel>
  )
}

export function Robots() {
  const canAdmin = useCan('admin')
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
        <div className="mono text-[14px] text-ink-2">
          {robots.length} {t('c.units')} · {Object.values(telemetry).filter((x) => x.mode !== 'idle').length} {t('c.tasked')}
        </div>
        <Button variant="utility" onClick={() => setConnect(true)} className="mono text-[11.5px] normal-case tracking-[0.1em] text-ink-2">
          <Plus size={13} /> {t('fl.connectRobot')}
        </Button>
      </div>

      {groups.map((g, gi) => (
        <div key={g.key} className={`rise rise-${gi + 1}`}>
          <div className="mb-2 flex items-center gap-2">
            <g.icon size={13} strokeWidth={1.5} className="text-ink-3" />
            <span className="microlabel">{g.label}</span>
            <span className="mono text-[11px] text-ink-3">{g.list.length}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {g.list.map((r) => (
              <RobotCard key={r.id} r={r} />
            ))}
            {g.key === 'ugv' && canAdmin && (
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
        <PanelHead label={t('fl.matrix')} right={<span className="mono text-[11px] text-ink-3">{t('fl.matrix.sub')}</span>} />
        <Table className="min-w-[560px]">
          <TableHeader>
            <TableRow className="border-line">
              <TableHead className="px-3.5 py-2">{t('fl.unit')}</TableHead>
              {kinds.map((k) => {
                const Icon = KIND_ICON[k]
                return (
                  <TableHead key={k} className="h-auto px-2 py-2">
                    <div className="flex flex-col items-center gap-1">
                      <Icon size={13} strokeWidth={1.5} className="text-ink-3" />
                      <span className="microlabel">{t(KIND_KEY[k])}</span>
                    </div>
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {robots.map((r) => (
              <TableRow key={r.id} className="border-line/60 last:border-0">
                <TableCell className="px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span style={{ width: 5, height: 5, borderRadius: r.family === 'ugv' ? 1 : 99, background: r.color, display: 'inline-block' }} />
                    <span className="mono text-[12.5px] text-ink">{r.callsign}</span>
                    <span className="microlabel hidden sm:inline">{r.family}</span>
                  </div>
                </TableCell>
                {kinds.map((k) => {
                  const p = r.payloads.find((x) => x.kind === k)
                  return (
                    <TableCell key={k} className="px-2 py-2.5 text-center">
                      {p ? (
                        <span title={`${p.name} · ${p.model}`} className="mono text-[12px]" style={{ color: p.stream ? 'var(--color-ink)' : 'var(--color-ink-2)' }}>
                          {p.stream ? '◉' : '●'}
                        </span>
                      ) : (
                        <span className="text-[12px] text-ink-3/40">—</span>
                      )}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center gap-4 border-t border-line px-3.5 py-2">
          <span className="mono text-[10.5px] text-ink-3">{t('fl.streaming')}</span>
          <span className="mono text-[10.5px] text-ink-3">{t('fl.telemetry')}</span>
        </div>
      </Panel>

      {connect && <ProvisionWizard onClose={() => setConnect(false)} />}
    </div>
  )
}
