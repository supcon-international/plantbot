import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ChevronLeft, ChevronRight, Grid2X2, Focus, Pencil, Plus, Radio, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { useApp, useCan, useSite, api } from '../lib/store'
import { useT } from '../lib/i18n'
import { FeedPlayer, VideoThumb } from '../components/StreamPlayer'
import { Modal, Panel } from '../components/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { utcClock } from '../lib/format'
import type { Channel, StreamSession } from '../lib/types'

interface Feed {
  channelId: string
  stream: string
  file?: string
  name: string
  origin: string
  live: boolean
  robotId?: string
}

// Chrome/VideoToolbox can intermittently reject the third simultaneous MSE
// decoder during wall-page remounts. Two tiles keeps every channel reachable
// while making repeated page changes reliable on ordinary demo laptops.
const WALL_PAGE_SIZE = 2

const ROLE_ORIGIN: Record<Channel['role'], string> = {
  front: 'onboard · front',
  optical: 'onboard · optical zoom',
  ptz: 'onboard · PTZ',
  thermal: 'onboard · radiometric',
  ogi: 'onboard · gas imaging',
  audio: 'onboard · audio',
  fixed: 'fixed camera',
}

/** feeds come from the site's Channel resources — the UI never touches raw payload wiring */
function useFeeds(): Feed[] {
  const channels = useApp((s) => s.channels)
  const robots = useApp((s) => s.robots)
  return useMemo(
    () =>
      channels.map((c) => ({
        channelId: c.id,
        stream: c.streamKey ?? c.id,
        file: c.source.kind === 'file' ? c.source.file : undefined,
        name: c.label,
        origin: c.robotId ? `${robots.find((r) => r.id === c.robotId)?.model ?? c.robotId} — ${ROLE_ORIGIN[c.role]}` : ROLE_ORIGIN[c.role],
        live: c.source.kind !== 'file',
        robotId: c.robotId,
      })),
    [channels, robots],
  )
}

/** open a playback lease for the channel; demo loops return a perpetual one */
function useSession(channelId?: string): StreamSession | null {
  const [session, setSession] = useState<StreamSession | null>(null)
  useEffect(() => {
    if (!channelId) return
    let dead = false
    let renewTimer: ReturnType<typeof setTimeout>
    let sid: string | null = null
    setSession(null)

    // keep a leased (expiring) session alive: renew ~20s before expiry, loop.
    // file sources have expiresAt:null and never schedule a renew.
    const scheduleRenew = (s: StreamSession) => {
      if (s.expiresAt === null) return
      const ms = Math.max(5_000, s.expiresAt - Date.now() - 20_000)
      renewTimer = setTimeout(async () => {
        if (dead) return
        const r = await api.renewSession(s.id).catch(() => null)
        if (dead) return
        if (r?.session) {
          setSession(r.session)
          scheduleRenew(r.session)
        } else {
          scheduleRenew({ ...s, expiresAt: Date.now() + 30_000 }) // transient miss — retry soon
        }
      }, ms)
    }

    api
      .openSession(channelId)
      .then((r) => {
        if (dead || !r.session) return
        sid = r.session.id
        setSession(r.session)
        scheduleRenew(r.session)
      })
      .catch(() => {})
    return () => {
      dead = true
      clearTimeout(renewTimer)
      if (sid) void api.closeSession(sid) // release the lease server-side
    }
  }, [channelId])
  return session
}

function PlayerOverlay({ feed, session }: { feed: Feed; session: StreamSession | null }) {
  const clock = useApp((s) => s.clock)
  const t = useT()
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/55 to-transparent px-3 pb-6 pt-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 live-dot" style={{ background: feed.live ? 'var(--color-ok)' : 'var(--color-accent)' }} />
          <span className="mono truncate text-[12px] font-medium tracking-[0.08em] text-white/90">{feed.name}</span>
          {feed.live && (
            <span className="mono shrink-0 whitespace-nowrap border border-ok/40 bg-ok/10 px-1 py-0.5 text-[10px] tracking-[0.12em] text-ok">
              {t('live.publicRtsp')}
            </span>
          )}
        </div>
        <span className="mono hidden text-[11px] text-white/60 sm:block">{utcClock(clock)}</span>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/55 to-transparent px-3 pb-2.5 pt-6">
        <span className="mono truncate text-[11px] text-white/55">{feed.origin}</span>
        {session && (
          <span className="mono shrink-0 text-[11px] text-white/45" title={t('live.sessionHint')}>
            {session.id} · {session.expiresAt === null ? t('live.loop') : `${Math.max(0, Math.round((session.expiresAt - clock) / 1000))}s`}
          </span>
        )}
      </div>
      <span className="pointer-events-none absolute left-2 top-2 h-3 w-3 border-l border-t border-white/25" />
      <span className="pointer-events-none absolute right-2 top-2 h-3 w-3 border-r border-t border-white/25" />
      <span className="pointer-events-none absolute bottom-2 left-2 h-3 w-3 border-b border-l border-white/25" />
      <span className="pointer-events-none absolute bottom-2 right-2 h-3 w-3 border-b border-r border-white/25" />
    </>
  )
}

/** a feed tile = session lease + the right transport for its protocol:
 *  file → native loop · mse → go2rtc relay (session.url is the stream name) */
function FeedTile({ feed }: { feed: Feed }) {
  const session = useSession(feed.channelId)
  const t = useT()
  // RTSP channels need the server-issued relay name. Starting VideoRTC with
  // the raw stream key and replacing it a moment later races the old socket's
  // close callback against the new socket, leaving a blank player.
  if (feed.live && !session)
    return (
      <>
        <div className="skeleton h-full w-full bg-black" />
        <PlayerOverlay feed={feed} session={null} />
      </>
    )
  if (session?.protocol === 'mse' && session.relayOnline === false)
    return (
      <>
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-black text-ink-3">
          <span className="mono text-[11px] tracking-[0.14em]">{t('live.relayOffline')}</span>
          <span className="mono text-[9.5px] text-ink-3/70">MEDIA_RELAY (go2rtc)</span>
        </div>
        <PlayerOverlay feed={feed} session={session} />
      </>
    )
  return (
    <>
      <FeedPlayer
        stream={session?.protocol === 'mse' ? session.url : feed.stream}
        file={session?.protocol === 'file' ? session.url : session?.protocol === 'mse' ? undefined : feed.file}
      />
      <PlayerOverlay feed={feed} session={session} />
    </>
  )
}

function WallFeedTile({ feed, order }: { feed: Feed; order: number }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // Avoid a burst of simultaneous decoder initialisation on lower-powered
    // clients; the focused feed stays mounted separately during mode changes.
    const timer = setTimeout(() => setMounted(true), 500 + order * 500)
    return () => clearTimeout(timer)
  }, [feed.channelId, order])

  if (mounted) return <FeedTile feed={feed} />
  return (
    <>
      <div className="skeleton h-full w-full bg-black" />
      <PlayerOverlay feed={feed} session={null} />
    </>
  )
}

export function Live() {
  const feeds = useFeeds()
  const t = useT()
  const isAdmin = useCan('admin')
  const siteId = useSite((s) => s.siteId)
  const [params, setParams] = useSearchParams()
  const [mode, setMode] = useState<'focus' | 'grid'>('focus')
  const [wallPage, setWallPage] = useState(0)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<{ id: string; name: string; rtsp: string; place: string } | null>(null)
  const active = params.get('src') ?? feeds[0]?.stream
  const feed = feeds.find((f) => f.stream === active) ?? feeds[0]
  const wallPages = Math.max(1, Math.ceil(feeds.length / WALL_PAGE_SIZE))
  const visibleWallFeeds = feeds.slice(wallPage * WALL_PAGE_SIZE, (wallPage + 1) * WALL_PAGE_SIZE)
  const displayedFeeds = mode === 'focus' ? (feed ? [feed] : []) : visibleWallFeeds
  useEffect(() => setWallPage(0), [siteId])
  useEffect(() => setWallPage((page) => Math.min(page, wallPages - 1)), [wallPages])
  // fixed site cameras are editable; robot channels belong to their adapter
  const fixedCamId = feed?.channelId.startsWith('cam:') ? feed.channelId.slice(4) : null

  const changeMode = (next: string) => {
    if (next !== 'focus' && next !== 'grid') return
    if (next === 'grid' && feed) {
      const index = feeds.findIndex((item) => item.channelId === feed.channelId)
      if (index >= 0) setWallPage(Math.floor(index / WALL_PAGE_SIZE))
    }
    setMode(next)
  }

  const openEdit = async () => {
    if (!fixedCamId) return
    // the admin fleet view carries the rtsp source (public surfaces strip it)
    const fl = await api.fleet(siteId)
    const cam = (fl.cameras ?? []).find((c: { id: string }) => c.id === fixedCamId)
    if (cam) setEditing({ id: cam.id, name: cam.name, rtsp: cam.rtsp ?? '', place: cam.place ?? '' })
  }

  const removeCamera = async () => {
    if (!fixedCamId || !confirm(t('live.deleteConfirm'))) return
    const r = await api.deleteCamera(siteId, fixedCamId)
    if (r.error) toast.error(r.error)
    else {
      toast.success(t('live.cameraRemoved'))
      setParams({}, { replace: true })
    }
  }

  if (feeds.length === 0)
    return (
      <div className="p-6">
        {isAdmin ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 border border-line">
            <span className="mono text-[12px] text-ink-3">{t('live.noFeeds')}</span>
            <Button variant="signal" size="sm" onClick={() => setAdding(true)} className="mono h-auto gap-1 px-3 py-1.5 text-[11px]">
              <Plus size={12} /> {t('live.addCamera')}
            </Button>
          </div>
        ) : (
          <div className="skeleton h-64 w-full" />
        )}
        {adding && <CameraModal onClose={() => setAdding(false)} />}
      </div>
    )

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 p-3 md:p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium text-ink">
            {mode === 'focus' ? feed?.name : `${t('live.allFeeds')} · ${feeds.length} ${t('live.channels')}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isAdmin && mode === 'focus' && fixedCamId && (
            <>
              <Button variant="ghost" size="sm" onClick={openEdit} className="mono h-auto gap-1 px-2 py-1.5 text-[11px] normal-case tracking-[0.08em] hover:bg-transparent">
                <Pencil size={11} /> {t('live.editCamera')}
              </Button>
              <Button variant="ghost" size="sm" onClick={removeCamera} className="mono h-auto gap-1 px-2 py-1.5 text-[11px] normal-case tracking-[0.08em] hover:bg-transparent hover:text-crit">
                <Trash2 size={11} /> {t('c.delete')}
              </Button>
            </>
          )}
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="mono h-auto gap-1 px-2.5 py-1.5 text-[11px] normal-case tracking-[0.08em]">
              <Plus size={12} /> {t('live.addCamera')}
            </Button>
          )}
          <ToggleGroup type="single" value={mode} onValueChange={changeMode} className="hidden md:flex">
            {(
              [
                ['focus', Focus, t('live.focus')],
                ['grid', Grid2X2, t('live.wall')],
              ] as const
            ).map(([m, Icon, label]) => (
              <ToggleGroupItem key={m} value={m} className="gap-1.5 px-3 data-[state=on]:bg-surface-2 data-[state=on]:text-ink">
                <Icon size={13} strokeWidth={1.5} />
                <span className="mono text-[12px] tracking-[0.08em]">{label}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {mode === 'grid' && wallPages > 1 && (
            <div className="hidden items-center gap-1 md:flex">
              <Button
                variant="ghost"
                size="iconSm"
                aria-label={t('fl.wiz.back')}
                disabled={wallPage === 0}
                onClick={() => setWallPage((page) => Math.max(0, page - 1))}
              >
                <ChevronLeft size={14} />
              </Button>
              <span className="mono min-w-10 text-center text-[11px] text-ink-3">
                {wallPage + 1} / {wallPages}
              </span>
              <Button
                variant="ghost"
                size="iconSm"
                aria-label={t('fl.wiz.next')}
                disabled={wallPage === wallPages - 1}
                onClick={() => setWallPage((page) => Math.min(wallPages - 1, page + 1))}
              >
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
        </div>
      </div>
      {adding && <CameraModal onClose={() => setAdding(false)} />}
      {editing && <CameraModal edit={editing} onClose={() => setEditing(null)} />}

      <div className={mode === 'focus' ? '' : 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'}>
        {displayedFeeds.map((item, index) => {
          const keepFocusedPlayer = item.channelId === feed?.channelId
          return (
            <Panel
              key={item.channelId}
              className={
                mode === 'focus'
                  ? 'rise relative aspect-video max-h-[62vh] w-full overflow-hidden'
                  : `rise rise-${(index % 5) + 1} relative aspect-video overflow-hidden`
              }
            >
              {mode === 'focus' || keepFocusedPlayer ? <FeedTile feed={item} /> : <WallFeedTile feed={item} order={index} />}
            </Panel>
          )
        })}
      </div>

      {mode === 'focus' && (
        <div className="-mx-3 overflow-x-auto px-3 md:mx-0 md:px-0">
          <div className="flex gap-2 md:grid md:grid-cols-7">
            {feeds.map((f) => {
              const sel = f.stream === feed?.stream
              return (
                <button
                  key={f.stream}
                  onClick={() => setParams({ src: f.stream }, { replace: true })}
                  className={`group relative aspect-video w-36 shrink-0 overflow-hidden border transition-colors md:w-auto ${
                    sel ? 'border-accent' : 'border-line hover:border-line-2'
                  }`}
                >
                  <VideoThumb
                    file={f.file}
                    className="h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
                  />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1.5 py-1 text-left">
                    <span className="mono block truncate text-[10px] tracking-[0.06em] text-white/85">
                      {f.name}
                    </span>
                  </span>
                  {f.live && (
                    <span className="absolute right-1 top-1 flex items-center gap-1 bg-black/60 px-1 py-0.5">
                      <Radio size={9} className="text-ok" />
                      <span className="mono text-[8px] text-ok">{t('live.live')}</span>
                    </span>
                  )}
                  {sel && <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-accent/60" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** create/edit a fixed RTSP camera — the server mutates the site geometry
 *  in place and the channel list refreshes over the WS geo frame */
function CameraModal({ edit, onClose }: { edit?: { id: string; name: string; rtsp: string; place: string }; onClose: () => void }) {
  const t = useT()
  const siteId = useSite((s) => s.siteId)
  const [name, setName] = useState(edit?.name ?? '')
  const [rtsp, setRtsp] = useState(edit?.rtsp ?? '')
  const [place, setPlace] = useState(edit?.place ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const title = edit ? t('live.editCamera') : t('live.addCamera')

  const save = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setErr('')
    const r = edit
      ? await api.patchCamera(siteId, edit.id, { name: name.trim(), rtsp: rtsp.trim(), place: place.trim() })
      : await api.addCamera(siteId, { name: name.trim(), rtsp: rtsp.trim() || undefined, place: place.trim() || undefined })
    setBusy(false)
    if (r.error) {
      setErr(r.error)
      return
    }
    toast.success(t(edit ? 'live.cameraSaved' : 'live.cameraAdded'))
    onClose()
  }

  return (
    <Modal onClose={onClose} title={title}>
      <div className="flex flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="microlabel">{title}</span>
          <Button variant="ghost" size="iconSm" onClick={onClose} aria-label="close">
            <X size={16} />
          </Button>
        </div>
        <div className="space-y-3 p-4">
          <div>
            <div className="microlabel mb-1">{t('live.camName')}</div>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Gate North PTZ" autoFocus className="mono h-auto bg-surface-2 py-1.5 text-[12px]" />
          </div>
          <div>
            <div className="microlabel mb-1">{t('live.camRtsp')}</div>
            <Input value={rtsp} onChange={(e) => setRtsp(e.target.value)} placeholder="rtsp://user:pass@10.0.0.4:554/stream1" className="mono h-auto bg-surface-2 py-1.5 text-[12px]" />
            <div className="mt-0.5 text-[10.5px] leading-snug text-ink-3">{t('live.camRtspHint')}</div>
          </div>
          <div>
            <div className="microlabel mb-1">{t('live.camPlace')}</div>
            <Input value={place} onChange={(e) => setPlace(e.target.value)} placeholder={t('live.camPlacePh')} className="mono h-auto bg-surface-2 py-1.5 text-[12px]" />
          </div>
          {err && <div className="mono border border-crit/40 bg-crit/10 px-2.5 py-1.5 text-[12px]" style={{ color: 'var(--color-crit)' }}>{err}</div>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" onClick={onClose} className="mono h-auto px-3 py-1.5 text-[11px]">{t('c.cancel')}</Button>
          <Button variant="signal" disabled={!name.trim() || busy} onClick={save} className="mono h-auto px-4 py-1.5 text-[11px] disabled:opacity-30">
            {edit ? t('c.save') : t('live.addCamera')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
