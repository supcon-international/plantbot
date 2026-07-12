import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Plus, X, Camera, Flame, Radar, Wind, AudioWaveform, Compass, ScanEye, Dog, Car, Check, Copy, PawPrint, Truck, ArrowUpRight } from 'lucide-react'
import { useApp, api, useCan } from '../lib/store'
import { useT, useLang, IDX } from '../lib/i18n'
import { BASE } from '../lib/base'
import { Panel, PanelHead, BatteryBar, ModeChip, Modal } from '../components/ui'
import { Button } from '@/components/ui/button'
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

/** per-vendor adapter launch recipe — mirrors integrations/ package scripts */
const ADAPTER_CMD: Record<string, (base: string) => string> = {
  Spot: (base) =>
    `cd integrations && \\\n  SPOT_HOST=<robot-ip> SPOT_PORT=443 \\\n  PLANTBOT_BASE=${base} PLANTBOT_KEY=<pbk_…> \\\n  pnpm run adapter:spot`,
  'Jueying X30': (base) =>
    `cd integrations && \\\n  DR_HOST=<robot-ip> DR_PORT=30000 \\\n  PLANTBOT_BASE=${base} PLANTBOT_KEY=<pbk_…> \\\n  pnpm run adapter:deeprobotics`,
  'GS Patrol F2': (base) =>
    `cd integrations && \\\n  GOSUNCN_BASE=<grobot-cloud-url> \\\n  PLANTBOT_BASE=${base} PLANTBOT_KEY=<pbk_…> \\\n  pnpm run adapter:gosuncn`,
}

/** connect wizard = integration guide. Plantbot is a pure integration layer:
 *  nothing is created here — the unit registers itself once its vendor
 *  adapter comes up with a site API key. */
function ConnectGuide({ onClose }: { onClose: () => void }) {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const li = IDX[lang]
  const nav = useNavigate()
  const canAdmin = useCan('admin')

  const [models, setModels] = useState<RobotModelSpec[]>([])
  useEffect(() => {
    api.getCatalog().then((c) => setModels(c.models ?? []))
  }, [])

  const [mode, setMode] = useState<'managed' | 'external' | null>(null)
  const [step, setStep] = useState(0)
  const [model, setModel] = useState<RobotModelSpec | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const launchCmd = model ? (ADAPTER_CMD[model.model]?.(`${location.origin}${BASE}`) ?? '') : ''
  const steps = [t('fl.wiz.stepMode'), t('fl.wiz.stepModel'), t('fl.wiz.stepGuide')]

  const SDK_TS = `npm i <plantbot>/sdk/adapter-sdk-ts    # @plantbot/adapter-sdk

import { PlantbotClient, waitForSite, pumpOrders } from '@plantbot/adapter-sdk'
const pb = new PlantbotClient({ base: '${location.origin}${BASE}', key: 'pbk_…' })
await waitForSite(pb)
await pb.registerUntilUp({ serial: 'MY-ROBOT-001', model: 'My Robot X1', level: 'dispatchable' })
setInterval(async () => {
  const rep = await pb.state('MY-ROBOT-001', { x: 0, z: 0, battery: 80, mode: 'idle' })
  await pumpOrders(pb, 'MY-ROBOT-001', rep, async (o) => pb.orderStatus(o.id, 'done'))
}, 1000)`
  const SDK_NR = `cd ~/.node-red && npm i <plantbot>/sdk/node-red-contrib-plantbot
# restart Node-RED, then import examples/minimal-adapter-flow.json —
# plantbot-robot (state 1 Hz) → plantbot-orders → switch(kind) → settle`

  return (
    <Modal onClose={onClose} wide title={t('fl.wiz.title')}>
      <div className="flex max-h-[86dvh] flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="microlabel">{t('fl.wiz.title')}</span>
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
          <Button variant="ghost" size="iconSm" onClick={onClose} aria-label="close">
            <X size={16} />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {step === 0 && (
            <div className="space-y-3">
              <div className="text-[12.5px] leading-relaxed text-ink-3">{t('fl.wiz.modeIntro')}</div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {(
                  [
                    ['managed', t('fl.wiz.modeManaged'), t('fl.wiz.modeManagedDesc')],
                    ['external', t('fl.wiz.modeExternal'), t('fl.wiz.modeExternalDesc')],
                  ] as const
                ).map(([m, title, desc]) => {
                  const sel = mode === m
                  return (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className="panel-hover border p-3.5 text-left"
                      style={{ borderColor: sel ? 'var(--color-accent)' : 'var(--color-line)' }}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[14px] font-medium text-ink">{title}</span>
                        {sel && <Check size={13} className="shrink-0 text-accent" />}
                      </div>
                      <div className="mt-1.5 text-[12px] leading-relaxed text-ink-3">{desc}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <div className="text-[12.5px] leading-relaxed text-ink-3">{t('fl.wiz.guideIntro')}</div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {models.map((m) => {
                  const sel = model?.model === m.model
                  return (
                    <button
                      key={m.model}
                      onClick={() => setModel(m)}
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
            </div>
          )}

          {step === 2 && model && (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-line/60 pb-2.5">
                <span className="microlabel">{t('fl.wiz.stepModel')}</span>
                <span className="mono text-[12px] text-ink-2">
                  {model.model} · {model.firmware}
                </span>
              </div>
              <div>
                <div className="microlabel mb-1">{t('fl.wiz.protocol')}</div>
                <div className="mono text-[12px] text-ink-2">{model.protocol}</div>
              </div>
              <div>
                <div className="microlabel mb-1">1 · {t('fl.wiz.apiKey')}</div>
                <div className="text-[12.5px] leading-relaxed text-ink-2">{t('fl.wiz.keyHint')}</div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="microlabel">2 · {t('fl.wiz.launch')}</span>
                  <CopyBtn text={launchCmd} tag="launch" copied={copied} setCopied={setCopied} t={t} />
                </div>
                <pre className="mono overflow-x-auto border border-line bg-surface-2 p-3 text-[11.5px] leading-relaxed text-ink-2">
                  {launchCmd}
                </pre>
              </div>
              <div>
                <div className="microlabel mb-1">3 · {t('fl.wiz.stepGuide')}</div>
                <div className="text-[12.5px] leading-relaxed text-ink-2">{t('fl.wiz.autoAppear')}</div>
              </div>

              {/* build-your-own adapter: the SDK in two flavors */}
              <div className="border-t border-line/60 pt-3">
                <div className="microlabel mb-1">{t('fl.wiz.sdkTitle')}</div>
                <div className="mb-2 text-[12.5px] leading-relaxed text-ink-3">{t('fl.wiz.sdkIntro')}</div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="mono text-[11px] tracking-[0.1em] text-ink-2">TYPESCRIPT · @plantbot/adapter-sdk</span>
                  <CopyBtn text={SDK_TS} tag="sdkts" copied={copied} setCopied={setCopied} t={t} />
                </div>
                <pre className="mono mb-3 overflow-x-auto border border-line bg-surface-2 p-3 text-[10.5px] leading-relaxed text-ink-2">
                  {SDK_TS}
                </pre>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="mono text-[11px] tracking-[0.1em] text-ink-2">NODE-RED · node-red-contrib-plantbot</span>
                  <CopyBtn text={SDK_NR} tag="sdknr" copied={copied} setCopied={setCopied} t={t} />
                </div>
                <pre className="mono overflow-x-auto border border-line bg-surface-2 p-3 text-[10.5px] leading-relaxed text-ink-2">
                  {SDK_NR}
                </pre>
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
          {step === 0 && mode === 'managed' ? (
            <Button
              variant="signal"
              onClick={() => {
                onClose()
                nav('/integrations')
              }}
              className="mono gap-1.5 px-3.5 text-[11.5px] normal-case tracking-[0.12em]"
            >
              {t('fl.wiz.openConnectors')} <ArrowUpRight size={12} />
            </Button>
          ) : step === 0 ? (
            <Button
              variant="outline"
              disabled={!mode}
              onClick={() => setStep(1)}
              className="mono px-3.5 text-[11.5px] normal-case tracking-[0.12em] text-ink disabled:opacity-40"
            >
              {t('fl.wiz.next')}
            </Button>
          ) : step === 1 ? (
            <Button
              variant="outline"
              disabled={!model}
              onClick={() => setStep(2)}
              className="mono px-3.5 text-[11.5px] normal-case tracking-[0.12em] text-ink disabled:opacity-40"
            >
              {t('fl.wiz.next')}
            </Button>
          ) : canAdmin ? (
            <Button
              variant="signal"
              onClick={() => nav('/integrations')}
              className="mono gap-1.5 px-3.5 text-[11.5px] normal-case tracking-[0.12em]"
            >
              {t('fl.wiz.openIntegrations')} <ArrowUpRight size={12} />
            </Button>
          ) : (
            <Button variant="outline" onClick={onClose} className="mono px-3.5 text-[11.5px] normal-case tracking-[0.12em] text-ink">
              {t('c.done')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

function CopyBtn({ text, tag, copied, setCopied, t }: { text: string; tag: string; copied: string | null; setCopied: (v: string | null) => void; t: (k: string) => string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {})
        setCopied(tag)
        setTimeout(() => setCopied(null), 1600)
      }}
      className="mono h-auto gap-1 px-2 py-1 text-[10px] normal-case tracking-[0.1em]"
    >
      <Copy size={10} /> {copied === tag ? t('fl.wiz.copied') : t('fl.wiz.copy')}
    </Button>
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

      {connect && <ConnectGuide onClose={() => setConnect(false)} />}
    </div>
  )
}
