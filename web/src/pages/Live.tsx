import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Grid2X2, Focus, Radio } from 'lucide-react'
import { useApp, api } from '../lib/store'
import { useT } from '../lib/i18n'
import { FeedPlayer, VideoThumb } from '../components/StreamPlayer'
import { Panel } from '../components/ui'
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
    setSession(null)
    api
      .openSession(channelId)
      .then((r) => {
        if (!dead && r.session) setSession(r.session)
      })
      .catch(() => {})
    return () => {
      dead = true
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

export function Live() {
  const feeds = useFeeds()
  const t = useT()
  const [params, setParams] = useSearchParams()
  const [mode, setMode] = useState<'focus' | 'grid'>('focus')
  const active = params.get('src') ?? feeds[0]?.stream
  const feed = feeds.find((f) => f.stream === active) ?? feeds[0]

  if (feeds.length === 0)
    return (
      <div className="p-6">
        <div className="skeleton h-64 w-full" />
      </div>
    )

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 p-3 md:p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[15px] font-medium text-ink">
            {mode === 'focus' ? feed?.name : `${t('live.allFeeds')} · ${feeds.length} ${t('live.channels')}`}
          </div>
        </div>
        <ToggleGroup type="single" value={mode} onValueChange={(v) => v && setMode(v as typeof mode)} className="hidden md:flex">
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
      </div>

      {mode === 'focus' ? (
        <>
          <Panel className="rise relative aspect-video max-h-[62vh] w-full overflow-hidden">
            {feed && <FeedTile key={feed.channelId} feed={feed} />}
          </Panel>

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
                    {sel && (
                      <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-accent/60" />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {feeds.map((f, i) => (
            <Panel key={f.channelId} className={`rise rise-${(i % 5) + 1} relative aspect-video overflow-hidden`}>
              <FeedTile feed={f} />
            </Panel>
          ))}
        </div>
      )}
    </div>
  )
}
