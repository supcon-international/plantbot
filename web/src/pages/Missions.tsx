import { useMemo, useState } from 'react'
import { Plus, X, ChevronUp, ChevronDown, OctagonX, Camera, Flame, Wind, AudioWaveform, Gauge, Timer, ScanEye } from 'lucide-react'
import { useApp, api } from '../lib/store'
import { useT, useAgo } from '../lib/i18n'
import { Panel, PanelHead, MissionStatusTag, EmptyNote, Modal } from '../components/ui'
import { OpsMap } from '../components/OpsMap'
import { timeShort } from '../lib/format'
import type { ActionType, Mission, MissionStep, Waypoint } from '../lib/types'
import { ACTION_TYPES } from '../lib/types'

const ACTION_ICON: Record<ActionType, any> = {
  capture_photo: Camera,
  thermal_scan: Flame,
  ogi_scan: ScanEye,
  gas_sample: Wind,
  acoustic_scan: AudioWaveform,
  gauge_read: Gauge,
  wait: Timer,
}

const ACTION_DEFAULT_S: Record<ActionType, number> = {
  capture_photo: 3,
  thermal_scan: 8,
  ogi_scan: 12,
  gas_sample: 6,
  acoustic_scan: 8,
  gauge_read: 6,
  wait: 5,
}

function wpName(id: string, waypoints: Waypoint[]) {
  return waypoints.find((w) => w.id === id)?.name ?? id
}

// ---------- create wizard ----------

function CreateMission({ onClose }: { onClose: () => void }) {
  const robots = useApp((s) => s.robots)
  const waypoints = useApp((s) => s.waypoints)
  const t = useT()
  const [name, setName] = useState('')
  const [priority, setPriority] = useState<1 | 2 | 3>(2)
  const [assignee, setAssignee] = useState('auto')
  const [recurring, setRecurring] = useState(false)
  const [steps, setSteps] = useState<MissionStep[]>([])
  const [busy, setBusy] = useState(false)

  const addWp = (wp: Waypoint) =>
    setSteps((s) => [...s, { waypointId: wp.id, actions: [{ type: 'capture_photo', durationS: 3 }] }])

  const move = (i: number, dir: -1 | 1) =>
    setSteps((s) => {
      const n = [...s]
      const j = i + dir
      if (j < 0 || j >= n.length) return s
      ;[n[i], n[j]] = [n[j], n[i]]
      return n
    })

  const toggleAction = (i: number, type: ActionType) =>
    setSteps((s) =>
      s.map((st, k) => {
        if (k !== i) return st
        const has = st.actions.some((a) => a.type === type)
        return {
          ...st,
          actions: has
            ? st.actions.filter((a) => a.type !== type)
            : [...st.actions, { type, durationS: ACTION_DEFAULT_S[type] }],
        }
      }),
    )

  const submit = async () => {
    if (!name.trim() || !steps.length) return
    setBusy(true)
    await api.createMission({ name: name.trim(), priority, requestedRobot: assignee, recurring, steps })
    onClose()
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="microlabel">{t('mi.wizTitle')}</span>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="close">
          <X size={16} />
        </button>
      </div>

      <div className="grid gap-4 p-4 md:grid-cols-2">
        <div className="space-y-3.5">
          <div>
            <div className="microlabel mb-1.5">{t('mi.wizName')}</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('mi.wizNamePh')}
              className="mono w-full border border-line-2 bg-surface-2 px-2.5 py-2 text-[12px] text-ink outline-none transition-colors focus:border-ink-3"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="microlabel mb-1.5">{t('mi.priority')}</div>
              <div className="flex overflow-hidden border border-line">
                {([1, 2, 3] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPriority(p)}
                    className={`mono flex-1 px-2 py-1.5 text-[11px] transition-colors ${priority === p ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink-2'}`}
                  >
                    P{p}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="microlabel mb-1.5">{t('mi.wizAssign')}</div>
              <select
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                className="mono w-full border border-line-2 bg-surface-2 px-2 py-1.5 text-[11px] text-ink outline-none"
              >
                <option value="auto">{t('mi.wizAuto')}</option>
                {robots.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.callsign}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2.5">
            <button
              onClick={() => setRecurring(!recurring)}
              className="relative h-4 w-8 border border-line-2 transition-colors"
              style={{ background: recurring ? 'var(--color-surface-3)' : 'transparent' }}
            >
              <span
                className="absolute top-0.5 h-2.5 w-2.5 transition-all"
                style={{ left: recurring ? 18 : 3, background: recurring ? 'var(--color-ink)' : 'var(--color-ink-3)' }}
              />
            </button>
            <span className="text-[12px] text-ink-2">{t('mi.wizRecurring')}</span>
          </label>

          <div>
            <div className="microlabel mb-1.5">{t('mi.wizTap')}</div>
            <OpsMap heightClass="h-[210px]" interactive={false} showEvents={false} labels={false} onWaypointClick={addWp} routePreview={steps.map((s) => s.waypointId)} className="border border-line" />
          </div>
        </div>

        <div className="flex min-h-[300px] flex-col">
          <div className="microlabel mb-1.5">
            {t('mi.wizSequence')} · {steps.length} {t('mi.wizStops')}
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto pr-1">
            {steps.length === 0 && (
              <div className="flex h-full items-center justify-center border border-dashed border-line-2">
                <span className="text-[12px] text-ink-3">{t('mi.wizNoStops')}</span>
              </div>
            )}
            {steps.map((st, i) => (
              <div key={i} className="border border-line bg-surface-2 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="mono flex h-5 w-5 items-center justify-center bg-surface-3 text-[10px] text-ink">{i + 1}</span>
                  <span className="mono text-[11px] text-ink">{st.waypointId}</span>
                  <span className="truncate text-[11px] text-ink-3">{wpName(st.waypointId, waypoints)}</span>
                  <span className="ml-auto flex shrink-0 items-center">
                    <button onClick={() => move(i, -1)} className="p-0.5 text-ink-3 hover:text-ink"><ChevronUp size={13} /></button>
                    <button onClick={() => move(i, 1)} className="p-0.5 text-ink-3 hover:text-ink"><ChevronDown size={13} /></button>
                    <button onClick={() => setSteps((s) => s.filter((_, k) => k !== i))} className="p-0.5 text-ink-3 hover:text-crit"><X size={13} /></button>
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {ACTION_TYPES.map((type) => {
                    const on = st.actions.some((a) => a.type === type)
                    const Icon = ACTION_ICON[type]
                    return (
                      <button
                        key={type}
                        onClick={() => toggleAction(i, type)}
                        className={`mono flex items-center gap-1 border px-1.5 py-0.5 text-[9px] tracking-[0.04em] transition-colors ${
                          on ? 'border-ink/40 bg-ink/10 text-ink' : 'border-line text-ink-3 hover:text-ink-2'
                        }`}
                      >
                        <Icon size={10} />
                        {t(`act.${type}`)}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <button
            disabled={!name.trim() || !steps.length || busy}
            onClick={submit}
            className="mono mt-3 w-full border border-ink/30 bg-ink/10 px-3 py-2.5 text-[11px] tracking-[0.12em] text-ink transition-colors hover:bg-ink/15 disabled:opacity-30"
          >
            {busy ? t('mi.wizSubmitting') : t('mi.wizQueue')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- detail ----------

function MissionDetail({ m }: { m: Mission }) {
  const waypoints = useApp((s) => s.waypoints)
  const robots = useApp((s) => s.robots)
  const t = useT()
  const robot = robots.find((r) => r.id === m.robotId)
  const flagged = m.results.filter((r) => !r.ok).length

  return (
    <div className="space-y-3">
      <Panel>
        <PanelHead
          label={`${m.id} · ${t('mi.plan')}`}
          right={
            (m.status === 'active' || m.status === 'queued') && (
              <button
                onClick={() => api.abortMission(m.id)}
                className="mono flex items-center gap-1 border border-line-2 px-1.5 py-0.5 text-[9px] tracking-[0.08em] text-ink-3 transition-colors hover:border-crit/50 hover:text-crit"
              >
                <OctagonX size={11} /> {t('c.abort')}
              </button>
            )
          }
        />
        <div className="p-3.5">
          <OpsMap heightClass="h-[200px] md:h-[240px]" interactive={false} showEvents={false} labels={false} routePreview={m.steps.map((s) => s.waypointId)} className="border border-line" />
          <div className="mt-3 grid grid-cols-3 gap-3 md:grid-cols-5">
            {[
              [t('c.status'), t(`ms.${m.status}`)],
              [t('mi.unit'), robot?.callsign ?? (m.requestedRobot === 'auto' ? 'AUTO' : m.requestedRobot)],
              [t('mi.priority'), `P${m.priority}`],
              [t('mi.stops'), m.steps.length],
              [t('mi.findings'), flagged ? `${flagged} ${t('mi.flagged')}` : t('mi.clean')],
            ].map(([k, v]) => (
              <div key={k as string}>
                <div className="microlabel mb-0.5">{k}</div>
                <div className="mono text-[11.5px]" style={{ color: k === t('mi.findings') && flagged ? 'var(--color-warn)' : 'var(--color-ink-2)' }}>
                  {v as string}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHead label={t('mi.stepTimeline')} />
        <div className="p-3.5">
          {m.steps.map((st, i) => {
            const cur = m.status === 'active' && i === m.currentStep
            const past = i < m.currentStep || m.status === 'done'
            const results = m.results.filter((r) => r.stepIdx === i)
            return (
              <div key={i} className="relative flex gap-3 pb-4 last:pb-0">
                {i < m.steps.length - 1 && <span className="absolute left-[7px] top-5 h-full w-px bg-line" />}
                <span
                  className={`mt-1 h-[15px] w-[15px] shrink-0 rotate-45 border ${cur ? 'border-ink bg-ink/20' : past ? 'border-ink-3 bg-surface-3' : 'border-line-2'}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`mono text-[11.5px] ${cur ? 'text-ink' : 'text-ink-2'}`}>{st.waypointId}</span>
                    <span className="text-[11.5px] text-ink-3">{wpName(st.waypointId, waypoints)}</span>
                    {cur && <span className="live-dot" />}
                    <span className="ml-auto flex gap-1">
                      {st.actions.map((a, k) => {
                        const Icon = ACTION_ICON[a.type]
                        return (
                          <span key={k} title={t(`act.${a.type}`)} className="flex h-5 w-5 items-center justify-center border border-line text-ink-3">
                            <Icon size={10} />
                          </span>
                        )
                      })}
                    </span>
                  </div>
                  {results.map((r, k) => (
                    <div key={k} className="mt-1.5 flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: r.ok ? 'var(--color-ok)' : 'var(--color-warn)' }} />
                      <span className="mono text-[10px] text-ink-3">{timeShort(r.ts)}</span>
                      <span className="text-[11px] text-ink-2">{r.note}</span>
                      {r.snapshot && <img src={r.snapshot} alt="" className="ml-auto h-9 w-14 shrink-0 border border-line object-cover" />}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </Panel>
    </div>
  )
}

// ---------- page ----------

function Row({ m, active, onClick }: { m: Mission; active: boolean; onClick: () => void }) {
  const robots = useApp((s) => s.robots)
  const clock = useApp((s) => s.clock)
  const ago = useAgo()
  const robot = robots.find((r) => r.id === m.robotId)
  return (
    <button
      onClick={onClick}
      className={`block w-full border-b border-line/70 px-3.5 py-2.5 text-left transition-colors ${active ? 'bg-surface-2' : 'hover:bg-surface-2/50'}`}
      style={active ? { boxShadow: 'inset 2px 0 0 var(--color-ink)' } : undefined}
    >
      <div className="flex items-center gap-2">
        <span className="mono text-[10px] text-ink-3">{m.id}</span>
        <span className="truncate text-[12.5px] text-ink">{m.name}</span>
        <span className="mono ml-auto shrink-0 text-[9px] text-ink-3">P{m.priority}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <MissionStatusTag status={m.status} />
        <span className="mono text-[10px] text-ink-3">
          {robot?.callsign ?? (m.requestedRobot === 'auto' ? 'auto' : m.requestedRobot)}
        </span>
        {m.status === 'active' && (
          <div className="ml-auto flex w-24 items-center gap-1.5">
            <div className="h-[3px] flex-1 bg-surface-3">
              <div className="h-full bg-ink/70 transition-[width] duration-500" style={{ width: `${m.progress * 100}%` }} />
            </div>
            <span className="mono text-[9px] text-ink-3">{Math.round(m.progress * 100)}%</span>
          </div>
        )}
        {m.status !== 'active' && (
          <span className="mono ml-auto text-[9.5px] text-ink-3">
            {m.endedAt ? ago(m.endedAt, clock) : ago(m.createdAt, clock)}
          </span>
        )}
      </div>
    </button>
  )
}

export function Missions() {
  const missions = useApp((s) => s.missions)
  const t = useT()
  const [selId, setSelId] = useState<string | null>(null)
  const [create, setCreate] = useState(false)

  const groups = useMemo(() => {
    const by = (st: string[]) =>
      missions.filter((m) => st.includes(m.status)).sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt))
    return {
      active: by(['active']),
      queued: missions.filter((m) => m.status === 'queued').sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt),
      history: by(['done', 'failed', 'aborted']).slice(0, 20),
    }
  }, [missions])

  const sel = missions.find((m) => m.id === selId) ?? groups.active[0] ?? groups.queued[0] ?? groups.history[0]

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 p-3 md:p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="microlabel">{t('mi.missionControl')}</div>
          <div className="mono mt-0.5 text-[13px] text-ink-2">
            {groups.active.length} {t('ms.active')} · {groups.queued.length} {t('ms.queued')}
          </div>
        </div>
        <button
          onClick={() => setCreate(true)}
          className="mono flex items-center gap-1.5 border border-ink/30 bg-ink/10 px-2.5 py-1.5 text-[10.5px] tracking-[0.1em] text-ink transition-colors hover:bg-ink/15"
        >
          <Plus size={13} /> {t('mi.newMission')}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <div className="space-y-3 lg:col-span-5">
          <Panel className="rise">
            <PanelHead label={`${t('mi.active')} · ${groups.active.length}`} />
            {groups.active.map((m) => (
              <Row key={m.id} m={m} active={sel?.id === m.id} onClick={() => setSelId(m.id)} />
            ))}
            {groups.active.length === 0 && <EmptyNote>{t('ops.noActiveMissions')}</EmptyNote>}
          </Panel>
          <Panel className="rise rise-1">
            <PanelHead label={`${t('mi.queued')} · ${groups.queued.length}`} />
            {groups.queued.map((m) => (
              <Row key={m.id} m={m} active={sel?.id === m.id} onClick={() => setSelId(m.id)} />
            ))}
            {groups.queued.length === 0 && <EmptyNote>{t('mi.queueEmpty')}</EmptyNote>}
          </Panel>
          <Panel className="rise rise-2">
            <PanelHead label={t('mi.history')} />
            {groups.history.map((m) => (
              <Row key={m.id} m={m} active={sel?.id === m.id} onClick={() => setSelId(m.id)} />
            ))}
            {groups.history.length === 0 && <EmptyNote>{t('mi.noCompleted')}</EmptyNote>}
          </Panel>
        </div>

        <div className="lg:col-span-7">
          {sel ? <MissionDetail m={sel} /> : <Panel><EmptyNote>{t('mi.selectMission')}</EmptyNote></Panel>}
        </div>
      </div>

      {create && <CreateMission onClose={() => setCreate(false)} />}
    </div>
  )
}
