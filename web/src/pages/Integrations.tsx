// Admin panel for the open integration API: site keys, external units,
// custom event vocabulary, occupancy-map upload (ROS map_server convention).
import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, Plug, Copy, Trash2, Upload, Tags, ListOrdered, RefreshCw } from 'lucide-react'
import { api, useApp, useCan, useSite } from '../lib/store'
import { BASE } from '../lib/base'
import { useT } from '../lib/i18n'
import { Panel, PanelHead } from '../components/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
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
  /** plaintext appears exactly once — from the create response, never the list */
  const [freshKey, setFreshKey] = useState<{ id: string; key: string } | null>(null)
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
    // admin-session route — keys are hashed at rest, so the console can't
    // borrow one; adapters keep using the integration API for uploads
    await api.uploadMap(siteId, {
      name: mapDraft.name || mapFile.name,
      resolution: Number(mapDraft.resolution),
      origin: [Number(mapDraft.originX), Number(mapDraft.originZ)],
      image: dataUrl,
    })
    setBusy(false)
    setMapFile(null)
    if (fileRef.current) fileRef.current.value = ''
    reload()
  }

  const curlBase = `${location.origin}${BASE}/api/integration/v1`
  const demoKey = freshKey?.key ?? 'pbk_<your-site-key>'

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
              <Input
                value={keyLabel}
                onChange={(e) => setKeyLabel(e.target.value)}
                placeholder={t('integ.keyLabel')}
                className="mono h-auto min-w-0 flex-1 bg-surface-2 py-1.5 text-[12px]"
              />
              <Button
                variant="signal"
                onClick={() =>
                  api.createApiKey(keyLabel).then((r: { apiKey?: ApiKeyRec & { key: string } }) => {
                    if (r.apiKey) setFreshKey({ id: r.apiKey.id, key: r.apiKey.key })
                    setKeyLabel('')
                    reload()
                  })
                }
                className="mono h-auto shrink-0 py-1.5 text-[11px] normal-case tracking-[0.1em]"
              >
                {t('integ.newKey')}
              </Button>
            </div>
            {freshKey && (
              <div className="border border-(--signal) bg-surface-2 p-2.5">
                <div className="microlabel" style={{ color: 'var(--signal)' }}>{t('integ.keyOnce')}</div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="mono min-w-0 flex-1 truncate text-[11px] text-ink">{freshKey.key}</span>
                  <Button variant="ghost" size="sm" onClick={() => copy(freshKey.key, 'fresh')} className="mono h-auto gap-1 px-1 py-0.5 text-[10.5px] normal-case tracking-normal hover:bg-transparent">
                    <Copy size={11} /> {copied === 'fresh' ? 'copied' : 'copy'}
                  </Button>
                </div>
              </div>
            )}
            {(sum?.apiKeys ?? []).map((k) => (
              <div key={k.id} className="border border-line bg-surface-2 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{k.label}</span>
                  <Button variant="ghost" size="iconSm" onClick={() => api.deleteApiKey(k.id).then(reload)} title={t('integ.revoke')} className="size-6 hover:bg-transparent hover:text-crit">
                    <Trash2 size={12} />
                  </Button>
                </div>
                <div className="mono mt-1 truncate text-[11px] text-ink-3">{k.prefix}</div>
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
              <Button variant="ghost" size="iconSm" onClick={reload} className="ml-auto size-6 hover:bg-transparent" aria-label="refresh">
                <RefreshCw size={12} />
              </Button>
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
                <Button variant="ghost" size="sm" onClick={() => api.removeExternal(u.id).then(reload)} className="mono h-auto px-1 py-0.5 text-[10.5px] normal-case tracking-normal hover:bg-transparent hover:text-crit">
                  {t('integ.remove')}
                </Button>
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
              <Input
                value={typeDraft.id}
                onChange={(e) => setTypeDraft({ ...typeDraft, id: e.target.value })}
                placeholder={t('integ.typeId')}
                className="mono h-auto w-36 bg-surface-2 py-1.5 text-[12px]"
              />
              <Input
                value={typeDraft.label}
                onChange={(e) => setTypeDraft({ ...typeDraft, label: e.target.value })}
                placeholder={t('integ.typeLabel')}
                className="mono h-auto min-w-0 flex-1 bg-surface-2 py-1.5 text-[12px]"
              />
              <Select value={typeDraft.severity} onValueChange={(v) => setTypeDraft({ ...typeDraft, severity: v as Severity })}>
                <SelectTrigger size="sm" className="mono bg-surface-2 text-[11px] normal-case tracking-normal">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['critical', 'high', 'info', 'low'] as Severity[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="signal"
                disabled={!typeDraft.id || !typeDraft.label}
                onClick={() => api.createEventType(typeDraft).then(() => (setTypeDraft({ id: '', label: '', severity: 'info' }), reload()))}
                className="mono h-auto py-1.5 text-[11px] normal-case tracking-[0.1em] disabled:opacity-30"
              >
                {t('integ.newType')}
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(sum?.eventTypes ?? []).map((et) => (
                <span key={et.id} className="mono flex items-center gap-1.5 border border-line bg-surface-2 px-2 py-1 text-[11px]">
                  <span style={{ color: SEVERITY_COLOR[et.severity] }}>●</span>
                  <span className="text-ink-2">{et.id}</span>
                  {et.builtin ? (
                    <span className="text-[9.5px] tracking-[0.1em] text-ink-3/70">{t('integ.builtin')}</span>
                  ) : (
                    <Button variant="ghost" size="iconSm" onClick={() => api.deleteEventType(et.id).then(reload)} className="size-4 hover:bg-transparent hover:text-crit" aria-label="delete type">
                      <Trash2 size={10} />
                    </Button>
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
              <label className="mono flex items-center text-[10.5px] text-ink-3">
                {t('integ.resolution')}
                <Input type="number" step="0.01" value={mapDraft.resolution} onChange={(e) => setMapDraft({ ...mapDraft, resolution: Number(e.target.value) })} className="mono ml-1 h-auto w-16 bg-surface-2 px-1.5 py-1 text-[11px]" />
              </label>
              <label className="mono flex items-center text-[10.5px] text-ink-3">
                {t('integ.originX')}
                <Input type="number" step="0.5" value={mapDraft.originX} onChange={(e) => setMapDraft({ ...mapDraft, originX: Number(e.target.value) })} className="mono ml-1 h-auto w-16 bg-surface-2 px-1.5 py-1 text-[11px]" />
              </label>
              <label className="mono flex items-center text-[10.5px] text-ink-3">
                {t('integ.originZ')}
                <Input type="number" step="0.5" value={mapDraft.originZ} onChange={(e) => setMapDraft({ ...mapDraft, originZ: Number(e.target.value) })} className="mono ml-1 h-auto w-16 bg-surface-2 px-1.5 py-1 text-[11px]" />
              </label>
              <Button
                variant="signal"
                disabled={!mapFile || busy}
                onClick={uploadMap}
                className="mono h-auto py-1.5 text-[11px] normal-case tracking-[0.1em] disabled:opacity-30"
              >
                {t('integ.upload')}
              </Button>
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
            <Table className="text-[12px]">
              <TableBody>
                {sum.orders.map((o) => (
                  <TableRow key={o.id} className="border-line/60 last:border-0">
                    <TableCell className="mono px-2 py-1.5 text-ink-3">{o.id}</TableCell>
                    <TableCell className="mono px-2 py-1.5 text-ink-2">{o.robotId}</TableCell>
                    <TableCell className="mono px-2 py-1.5 text-ink-2">{o.kind}{o.payload.name ? ` · ${o.payload.name}` : o.kind === 'goto' ? ` · (${o.payload.x}, ${o.payload.z})` : ''}</TableCell>
                    <TableCell className="mono px-2 py-1.5" style={{ color: o.state === 'failed' ? 'var(--color-crit)' : o.state === 'done' ? 'var(--color-ok)' : 'var(--color-ink-3)' }}>{o.state}</TableCell>
                    <TableCell className="mono px-2 py-1.5 text-ink-3">{fmtAgo(o.updatedAt, clock)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
  -d '{"serial":"ACME-0007","model":"Spot","level":"dispatchable","home":{"x":-6,"z":-4}}'

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
