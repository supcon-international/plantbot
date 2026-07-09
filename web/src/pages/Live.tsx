import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Grid2X2, Focus, Radio } from 'lucide-react'
import { useApp } from '../lib/store'
import { useT } from '../lib/i18n'
import { FeedPlayer, SnapshotImg } from '../components/StreamPlayer'
import { Panel } from '../components/ui'
import { utcClock } from '../lib/format'

interface Feed {
  stream: string
  file?: string
  name: string
  origin: string
  live: boolean
  robotId?: string
}

function useFeeds(): Feed[] {
  const robots = useApp((s) => s.robots)
  const cameras = useApp((s) => s.cameras)
  return useMemo(() => {
    const fs: Feed[] = []
    for (const r of robots)
      for (const p of r.payloads)
        if (p.stream)
          fs.push({
            stream: p.stream,
            file: p.file,
            name: `${r.callsign} · ${p.name}`,
            origin: `${r.model} — onboard camera`,
            live: false,
            robotId: r.id,
          })
    for (const c of cameras)
      fs.push({ stream: c.stream, file: c.file, name: c.name, origin: c.source, live: c.live })
    return fs
  }, [robots, cameras])
}

function StreamMeta({ stream, file }: { stream: string; file?: string }) {
  const [meta, setMeta] = useState<string>('')
  useEffect(() => {
    if (file) return // local loop — static label, no probe
    let dead = false
    const load = async () => {
      try {
        const r = await fetch(`/stream/api/streams?src=${encodeURIComponent(stream)}`)
        const j = await r.json()
        const prod = j?.producers?.[0]?.medias as string[] | undefined
        const m = prod?.find((x: string) => x.includes('video'))
        if (!dead && m) {
          const codec = m.match(/(H264|H265|MJPEG|JPEG|AV1|VP9)/i)?.[1] ?? ''
          setMeta(codec.toUpperCase())
        }
      } catch {
        /* ignore */
      }
    }
    load()
    return () => {
      dead = true
    }
  }, [stream, file])
  if (file) return <span className="mono text-[11px] text-white/45">H264 · LOOP</span>
  return meta ? <span className="mono text-[11px] text-white/45">{meta} · RTSP</span> : null
}

function PlayerOverlay({ feed }: { feed: Feed }) {
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
        <span className="mono text-[11px] text-white/55">{feed.origin}</span>
        <StreamMeta stream={feed.stream} file={feed.file} />
      </div>
      <span className="pointer-events-none absolute left-2 top-2 h-3 w-3 border-l border-t border-white/25" />
      <span className="pointer-events-none absolute right-2 top-2 h-3 w-3 border-r border-t border-white/25" />
      <span className="pointer-events-none absolute bottom-2 left-2 h-3 w-3 border-b border-l border-white/25" />
      <span className="pointer-events-none absolute bottom-2 right-2 h-3 w-3 border-b border-r border-white/25" />
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
        <div className="hidden overflow-hidden border border-line md:flex">
          {(
            [
              ['focus', Focus, t('live.focus')],
              ['grid', Grid2X2, t('live.wall')],
            ] as const
          ).map(([m, Icon, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] transition-colors ${
                mode === m ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              <Icon size={13} strokeWidth={1.5} />
              <span className="mono tracking-[0.08em]">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {mode === 'focus' ? (
        <>
          <Panel className="rise relative aspect-video max-h-[62vh] w-full overflow-hidden">
            {feed && (
              <>
                <FeedPlayer stream={feed.stream} file={feed.file} />
                <PlayerOverlay feed={feed} />
              </>
            )}
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
                    <SnapshotImg
                      src={`/stream/api/frame.jpeg?src=${f.stream}`}
                      refreshMs={15000}
                      className="h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
                      alt={f.name}
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
            <Panel key={f.stream} className={`rise rise-${(i % 5) + 1} relative aspect-video overflow-hidden`}>
              <FeedPlayer stream={f.stream} file={f.file} />
              <PlayerOverlay feed={f} />
            </Panel>
          ))}
        </div>
      )}
    </div>
  )
}
