// Admin panel for the open integration API: site keys, external units,
// custom event vocabulary, occupancy-map upload (ROS map_server convention).
import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, Plug, Copy, Trash2, Upload, Tags, ListOrdered, RefreshCw } from 'lucide-react'
import { api, useApp, useCan, useSite } from '../lib/store'
import { BASE } from '../lib/base'
import { useT } from '../lib/i18n'
import { Panel, PanelHead } from '../components/ui'
import type { AdapterOrder, ApiKeyRec, EventTypeDef, ExternalUnit, Severity, SiteMapMeta } from '../lib/types'
import { SEVERITY_COLOR } from '../lib/types'

interface Summary {
  apiKeys: ApiKeyRec[]
  eventTypes: EventTypeDef[]
  externals: ExternalUnit[]
  orders: AdapterOrder[]
  map: SiteMapMeta | null
}

const fmtAgo = (ts: number, now: number) => {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export function Integrations() {
  const t = useT()
  const isAdmin = useCan('admin')
  const siteId = useSite((s) => s.siteId)
  const site = useApp((s) => s.site)
  const clock = useApp((s) => s.clock)
  const [sum, setSum] = useState<Summary | null>(null)
  const [keyLabel, setKeyLabel] = useState('')
  const [typeDraft, setTypeDraft] = useState({ id: '', label: '', severity: 'info' as Severity })
  const [copied, setCopied] = useState<string | null>(null)
  const [mapDraft, setMapDraft] = useState({ resolution: 0.05, originX: -16, originZ: -9, name: '' })
  const [mapFile, setMapFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(() => {
    api
      .integrations()
      .then((d: Summary & { error?: string }) => (d.error ? undefined : setSum(d)))
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (isAdmin) reload()
  }, [isAdmin, siteId, reload])

  if (!isAdmin)
    return (
      <div className="flex h-full items-center justify-center">
        <span className="mono text-[12px] text-ink-3">admin role required</span>
      </div>
    )

  const copy = (text: string, id: string) => {
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(id)
    setTimeout(() => setCopied(null), 1200)
  }

  const uploadMap = async () => {
    if (!mapFile || busy) return
    setBusy(true)
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(String(r.result))
      r.onerror = rej
      r.readAsDataURL(mapFile)
    })
    const key = sum?.apiKeys[0]
    // map upload rides the integration API — reuse (or mint) a site key
    const k = key ?? ((await api.createApiKey('map upload (auto)')) as { apiKey: ApiKeyRec }).apiKey
    await fetch(`${BASE}/api/integration/v1/maps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${k.key}` },
      body: JSON.stringify({
        name: mapDraft.name || mapFile.name,
        resolution: Number(mapDraft.resolution),
        origin: [Number(mapDraft.originX), Number(mapDraft.originZ)],
        image: dataUrl,
      }),
    })
    setBusy(false)
    setMapFile(null)
    if (fileRef.current) fileRef.current.value = ''
    reload()
  }

  const curlBase = `${location.origin}${BASE}/api/integration/v1`
  const demoKey = sum?.apiKeys[0]?.key ?? 'pbk_…'

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-3 md:p-4">
      <div>
        <div className="flex items-center gap-2 text-ink">
          <Plug size={15} />
          <span className="text-[15px] font-medium">{t('integ.title')}</span>
        </div>
        <p className="microlabel mt-1">{t('integ.sub')}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------- API keys ---------- */}
        <Panel>
          <PanelHead label={
            <span className="flex items-center gap-2">
              <KeyRound size={13} /> {t('integ.keys')}
            </span>
          } />
          <div className="space-y-2 p-3">
            <div className="flex gap-2">
              <input
                value={keyLabel}
                onChange={(e) => setKeyLabel(e.target.value)}
                placeholder={t('integ.keyLabel')}
                className="mono min-w-0 flex-1 border border-line-2 bg-surface-2 px-2 py-1.5 text-[12px] text-ink outline-none"
              />
              <button
                onClick={() => api.createApiKey(keyLabel).then(() => (setKeyLabel(''), reload()))}
                className="mono shrink-0 border border-ink/30 bg-ink/10 px-2.5 py-1.5 text-[11px] tracking-[0.1em] text-ink hover:bg-ink/15"
              >
                {t('integ.newKey')}
              </button>
            </div>
            {(sum?.apiKeys ?? []).map((k) => (
              <div key={k.id} className="border border-line bg-surface-2 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{k.label}</span>
                  <button onClick={() => copy(k.key, k.id)} className="mono flex items-center gap-1 text-[10.5px] text-ink-3 hover:text-ink">
                    <Copy size={11} /> {copied === k.id ? 'copied' : 'copy'}
                  </button>
                  <button onClick={() => api.deleteApiKey(k.id).then(reload)} title={t('integ.revoke')} className="text-ink-3 hover:text-crit">
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="mono mt-1 truncate text-[11px] text-ink-3">{k.key}</div>
                <div className="microlabel mt-1">
                  {t('integ.created')} {new Date(k.createdAt).toISOString().slice(0, 10)} · {t('integ.lastUsed')}{' '}
                  {k.lastUsedAt ? fmtAgo(k.lastUsedAt, clock) : t('integ.never')}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        {/* ---------- external units ---------- */}
        <Panel>
          <PanelHead label={
            <span className="flex items-center gap-2">
              <Plug size={13} /> {t('integ.externals')}
              <button onClick={reload} className="ml-auto text-ink-3 hover:text-ink" aria-label="refresh">
                <RefreshCw size={12} />
              </button>
            </span>
          } />
          <div className="space-y-2 p-3">
            {!sum?.externals.length && <p className="text-[12.5px] leading-relaxed text-ink-3">{t('integ.noExternals')}</p>}
            {(sum?.externals ?? []).map((u) => (
              <div key={u.id} className="flex items-center gap-2.5 border border-line bg-surface-2 p-2.5">
                <span className="live-dot shrink-0" style={{ background: u.online ? 'var(--color-ok)' : 'var(--color-crit)' }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="mono text-[12.5px] text-ink">{u.callsign}</span>
                    <span className="truncate text-[11.5px] text-ink-3">{u.model} · {u.serial}</span>
                  </div>
                  <div className="microlabel mt-0.5">
                    {t(`integ.level.${u.level ?? 'state-only'}`)} · {u.online ? t('integ.online') : t('integ.offline')} ·{' '}
                    {fmtAgo(u.lastSeen, clock)}
                  </div>
                </div>
                <button onClick={() => api.removeExternal(u.id).then(reload)} className="mono text-[10.5px] text-ink-3 hover:text-crit">
                  {t('integ.remove')}
                </button>
              </div>
            ))}
          </div>
        </Panel>

        {/* ---------- event vocabulary ---------- */}
        <Panel>
          <PanelHead label={
            <span className="flex items-center gap-2">
              <Tags size={13} /> {t('integ.types')}
            </span>
          } />
          <div className="space-y-2 p-3">
            <div className="flex flex-wrap gap-2">
              <input
                value={typeDraft.id}
                onChange={(e) => setTypeDraft({ ...typeDraft, id: e.target.value })}
                placeholder={t('integ.typeId')}
                className="mono w-36 border border-line-2 bg-surface-2 px-2 py-1.5 text-[12px] text-ink outline-none"
              />
              <input
                value={typeDraft.label}
                onChange={(e) => setTypeDraft({ ...typeDraft, label: e.target.value })}
                placeholder={t('integ.typeLabel')}
                className="mono min-w-0 flex-1 border border-line-2 bg-surface-2 px-2 py-1.5 text-[12px] text-ink outline-none"
              />
              <select
                value={typeDraft.severity}
                onChange={(e) => setTypeDraft({ ...typeDraft, severity: e.target.value as Severity })}
                className="mono border border-line-2 bg-surface-2 px-1.5 py-1.5 text-[11px] text-ink outline-none"
              >
                {(['critical', 'high', 'info', 'low'] as Severity[]).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                disabled={!typeDraft.id || !typeDraft.label}
                onClick={() => api.createEventType(typeDraft).then(() => (setTypeDraft({ id: '', label: '', severity: 'info' }), reload()))}
                className="mono border border-ink/30 bg-ink/10 px-2.5 py-1.5 text-[11px] tracking-[0.1em] text-ink hover:bg-ink/15 disabled:opacity-30"
              >
                {t('integ.newType')}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(sum?.eventTypes ?? []).map((et) => (
                <span key={et.id} className="mono flex items-center gap-1.5 border border-line bg-surface-2 px-2 py-1 text-[11px]">
                  <span style={{ color: SEVERITY_COLOR[et.severity] }}>●</span>
                  <span className="text-ink-2">{et.id}</span>
                  {et.builtin ? (
                    <span className="text-[9.5px] tracking-[0.1em] text-ink-3/70">{t('integ.builtin')}</span>
                  ) : (
                    <button onClick={() => api.deleteEventType(et.id).then(reload)} className="text-ink-3 hover:text-crit" aria-label="delete type">
                      <Trash2 size={10} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        </Panel>

        {/* ---------- occupancy map ---------- */}
        <Panel>
          <PanelHead label={
            <span className="flex items-center gap-2">
              <Upload size={13} /> {t('integ.map')}
            </span>
          } />
          <div className="space-y-2.5 p-3">
            <p className="text-[12px] leading-relaxed text-ink-3">{t('integ.mapHint')}</p>
            {site?.map ? (
              <div className="flex items-center gap-3 border border-line bg-surface-2 p-2.5">
                <img src={site.map.image} alt="occupancy" className="h-16 w-28 border border-line-2 object-cover" />
                <div className="mono text-[11px] leading-relaxed text-ink-3">
                  {t('integ.uploaded')}: {site.map.source}
                  <br />
                  {site.map.width}×{site.map.height}px · {site.map.resolution} m/px · origin [{site.map.origin.join(', ')}]
                </div>
              </div>
            ) : (
              <p className="mono text-[11px] text-ink-3/80">{t('integ.noMap')}</p>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <input ref={fileRef} type="file" accept="image/png" onChange={(e) => setMapFile(e.target.files?.[0] ?? null)} className="mono w-full text-[11px] text-ink-3 file:mr-2 file:border file:border-line file:bg-surface-2 file:px-2 file:py-1 file:text-ink-2" />
              <label className="mono text-[10.5px] text-ink-3">
                {t('integ.resolution')}
                <input type="number" step="0.01" value={mapDraft.resolution} onChange={(e) => setMapDraft({ ...mapDraft, resolution: Number(e.target.value) })} className="ml-1 w-16 border border-line-2 bg-surface-2 px-1.5 py-1 text-[11px] text-ink outline-none" />
              </label>
              <label className="mono text-[10.5px] text-ink-3">
                {t('integ.originX')}
                <input type="number" step="0.5" value={mapDraft.originX} onChange={(e) => setMapDraft({ ...mapDraft, originX: Number(e.target.value) })} className="ml-1 w-16 border border-line-2 bg-surface-2 px-1.5 py-1 text-[11px] text-ink outline-none" />
              </label>
              <label className="mono text-[10.5px] text-ink-3">
                {t('integ.originZ')}
                <input type="number" step="0.5" value={mapDraft.originZ} onChange={(e) => setMapDraft({ ...mapDraft, originZ: Number(e.target.value) })} className="ml-1 w-16 border border-line-2 bg-surface-2 px-1.5 py-1 text-[11px] text-ink outline-none" />
              </label>
              <button
                disabled={!mapFile || busy}
                onClick={uploadMap}
                className="mono border border-ink/30 bg-ink/10 px-2.5 py-1.5 text-[11px] tracking-[0.1em] text-ink hover:bg-ink/15 disabled:opacity-30"
              >
                {t('integ.upload')}
              </button>
            </div>
          </div>
        </Panel>
      </div>

      {/* ---------- recent orders ---------- */}
      <Panel>
          <PanelHead label={
          <span className="flex items-center gap-2">
            <ListOrdered size={13} /> {t('integ.orders')}
          </span>
        } />
        <div className="overflow-x-auto p-1.5">
          {!sum?.orders.length ? (
            <p className="mono p-2 text-[11px] text-ink-3/80">—</p>
          ) : (
            <table className="w-full text-left text-[12px]">
              <tbody>
                {sum.orders.map((o) => (
                  <tr key={o.id} className="border-b border-line/60 last:border-0">
                    <td className="mono px-2 py-1.5 text-ink-3">{o.id}</td>
                    <td className="mono px-2 py-1.5 text-ink-2">{o.robotId}</td>
                    <td className="mono px-2 py-1.5 text-ink-2">{o.kind}{o.payload.name ? ` · ${o.payload.name}` : o.kind === 'goto' ? ` · (${o.payload.x}, ${o.payload.z})` : ''}</td>
                    <td className="mono px-2 py-1.5" style={{ color: o.state === 'failed' ? 'var(--color-crit)' : o.state === 'done' ? 'var(--color-ok)' : 'var(--color-ink-3)' }}>{o.state}</td>
                    <td className="mono px-2 py-1.5 text-ink-3">{fmtAgo(o.updatedAt, clock)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Panel>

      {/* ---------- quick start ---------- */}
      <Panel>
          <PanelHead label={<span>{t('integ.docs')}</span>} />
        <pre className="mono overflow-x-auto p-3 text-[11px] leading-relaxed text-ink-3">
{`# register a robot (factsheet)   levels: state-only | dispatchable
curl -X POST ${curlBase}/robots -H 'authorization: Bearer ${demoKey}' \\
  -H 'content-type: application/json' \\
  -d '{"serial":"ACME-0007","model":"ANYmal C","level":"dispatchable","home":{"x":-6,"z":-4}}'

# push state @1Hz (doubles as heartbeat)
curl -X POST ${curlBase}/robots/ACME-0007/state -H 'authorization: Bearer ${demoKey}' \\
  -H 'content-type: application/json' \\
  -d '{"x":-5.5,"z":-3.8,"heading":1.2,"speed":0.6,"battery":81,"mode":"navigating"}'

# pull queued orders (goto / mission), then report completion
curl ${curlBase}/robots/ACME-0007/orders -H 'authorization: Bearer ${demoKey}'
curl -X POST ${curlBase}/orders/OR-0001/status -H 'authorization: Bearer ${demoKey}' \\
  -H 'content-type: application/json' -d '{"status":"done"}'

# push a custom event (register its type in this panel first)
curl -X POST ${curlBase}/events -H 'authorization: Bearer ${demoKey}' \\
  -H 'content-type: application/json' \\
  -d '{"type":"valve-leak","robotSerial":"ACME-0007","detail":"CH4 8ppm at flange B-12"}'

# full reference: docs/integration.md`}
        </pre>
      </Panel>
    </div>
  )
}
