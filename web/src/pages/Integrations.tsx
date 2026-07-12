// Admin panel for the open integration API: managed connectors (platform-run
// vendor adapters), site keys, external units, custom event vocabulary,
// occupancy-map upload (ROS map_server convention).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Cpu, KeyRound, Plug, Copy, Trash2, Upload, Tags, ListOrdered, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, useApp, useCan, useSite } from '../lib/store'
import { BASE } from '../lib/base'
import { useT } from '../lib/i18n'
import { Modal, Panel, PanelHead } from '../components/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import type { AdapterOrder, ApiKeyRec, Connector, ConnectorCatalogEntry, ConnectorField, EventTypeDef, ExternalUnit, Severity, SiteMapMeta } from '../lib/types'
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

      {/* ---------- managed connectors (platform runs the adapter) ---------- */}
      <ConnectorsPanel siteId={siteId} />

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

// ---------- managed connectors (platform-hosted vendor adapters) ----------

const STATUS_DOT: Record<string, string> = {
  running: 'var(--color-ok)',
  backoff: 'var(--color-warn, #e0a400)',
  stopped: 'var(--color-ink-3)',
}

function ConnectorsPanel({ siteId }: { siteId: string }) {
  const t = useT()
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [catalog, setCatalog] = useState<ConnectorCatalogEntry[]>([])
  const [creating, setCreating] = useState(false)
  const [logsFor, setLogsFor] = useState<Connector | null>(null)

  const reload = useCallback(() => {
    api
      .connectors(siteId)
      .then((d: { connectors?: Connector[]; catalog?: ConnectorCatalogEntry[]; error?: string }) => {
        if (d.error) return
        setConnectors(d.connectors ?? [])
        setCatalog(d.catalog ?? [])
      })
      .catch(() => {})
  }, [siteId])

  useEffect(() => {
    reload()
    const timer = setInterval(reload, 8000) // runtime status drifts (backoff → running)
    return () => clearInterval(timer)
  }, [reload])

  const act = async (c: Connector, action: 'start' | 'stop' | 'restart') => {
    const r = await api.connectorAction(siteId, c.id, action)
    if (r.error) toast.error(r.error)
    reload()
  }
  const remove = async (c: Connector) => {
    if (!confirm(t('conn.deleteConfirm'))) return
    const r = await api.deleteConnector(siteId, c.id)
    if (r.error) toast.error(r.error)
    reload()
  }

  return (
    <Panel>
      <PanelHead
        label={
          <span className="flex items-center gap-2">
            <Cpu size={13} /> {t('conn.title')}
            <Button variant="ghost" size="iconSm" onClick={reload} className="ml-auto size-6 hover:bg-transparent" aria-label="refresh">
              <RefreshCw size={12} />
            </Button>
          </span>
        }
      />
      <div className="space-y-2 p-3">
        <p className="text-[12.5px] leading-relaxed text-ink-3">{t('conn.sub')}</p>
        {connectors.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-2.5 border border-line bg-surface-2 p-2.5">
            <span className="live-dot shrink-0" style={{ background: STATUS_DOT[c.runtime.status] }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="mono text-[12.5px] text-ink">{c.name}</span>
                <span className="truncate text-[11.5px] text-ink-3">
                  {catalog.find((v) => v.vendor === c.vendor)?.model ?? c.vendor} · {String(c.config.serial ?? c.config.sn ?? '')}
                </span>
              </div>
              <div className="microlabel mt-0.5">
                {t(`conn.status.${c.runtime.status}`)}
                {c.runtime.pid ? ` · pid ${c.runtime.pid}` : ''}
                {c.runtime.restarts > 0 ? ` · ${t('conn.restarts')} ${c.runtime.restarts}` : ''}
                {c.runtime.status !== 'running' && c.runtime.lastExit ? ` · ${c.runtime.lastExit}` : ''}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {c.enabled ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => act(c, 'restart')} className="mono h-auto px-1.5 py-0.5 text-[10.5px] normal-case tracking-normal hover:bg-transparent">
                    {t('conn.restart')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => act(c, 'stop')} className="mono h-auto px-1.5 py-0.5 text-[10.5px] normal-case tracking-normal hover:bg-transparent">
                    {t('conn.stop')}
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => act(c, 'start')} className="mono h-auto px-1.5 py-0.5 text-[10.5px] normal-case tracking-normal hover:bg-transparent text-accent">
                  {t('conn.start')}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setLogsFor(c)} className="mono h-auto px-1.5 py-0.5 text-[10.5px] normal-case tracking-normal hover:bg-transparent">
                {t('conn.logs')}
              </Button>
              <Button variant="ghost" size="iconSm" onClick={() => remove(c)} aria-label="delete" className="hover:text-crit">
                <Trash2 size={13} />
              </Button>
            </div>
          </div>
        ))}
        {!connectors.length && <p className="mono text-[11.5px] text-ink-3">{t('conn.none')}</p>}
        <Button variant="signal" size="sm" onClick={() => setCreating(true)} className="mono h-auto px-3 py-1.5 text-[11px]">
          + {t('conn.new')}
        </Button>
      </div>
      {creating && (
        <NewConnectorModal
          siteId={siteId}
          catalog={catalog}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            reload()
          }}
        />
      )}
      {logsFor && <ConnectorLogsModal siteId={siteId} connector={logsFor} onClose={() => setLogsFor(null)} />}
    </Panel>
  )
}

function FieldInput({ f, value, onChange }: { f: ConnectorField; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="microlabel mb-1">
        {f.label}
        {f.required && <span className="text-crit"> *</span>}
      </div>
      <Input
        type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={f.placeholder}
        className="mono h-auto bg-surface-2 py-1.5 text-[12px]"
      />
      {f.hint && <div className="mt-0.5 text-[10.5px] leading-snug text-ink-3">{f.hint}</div>}
    </div>
  )
}

function NewConnectorModal({
  siteId,
  catalog,
  onClose,
  onCreated,
}: {
  siteId: string
  catalog: ConnectorCatalogEntry[]
  onClose: () => void
  onCreated: () => void
}) {
  const t = useT()
  const [vendor, setVendor] = useState<ConnectorCatalogEntry | null>(null)
  const [name, setName] = useState('')
  const [cfg, setCfg] = useState<Record<string, string>>({})
  const [streams, setStreams] = useState<{ name: string; url: string; kind: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const setField = (k: string, v: string) => setCfg((c) => ({ ...c, [k]: v }))

  const create = async () => {
    if (!vendor || busy) return
    setBusy(true)
    setErr('')
    const r = await api.createConnector(siteId, {
      vendor: vendor.vendor,
      name: name.trim(),
      config: { ...cfg, streams: streams.filter((s) => s.name.trim() && s.url.trim()) },
    })
    setBusy(false)
    if (r.error) {
      setErr(r.error)
      return
    }
    toast.success(t('conn.created'))
    onCreated()
  }

  return (
    <Modal onClose={onClose} wide title={t('conn.new')}>
      <div className="flex max-h-[86dvh] flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="microlabel">{t('conn.new')}</span>
          <Button variant="ghost" size="iconSm" onClick={onClose} aria-label="close">
            <X size={16} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {/* vendor pick */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            {catalog.map((v) => {
              const sel = vendor?.vendor === v.vendor
              return (
                <button
                  key={v.vendor}
                  onClick={() => setVendor(v)}
                  className="panel-hover border p-3 text-left"
                  style={{ borderColor: sel ? 'var(--color-accent)' : 'var(--color-line)' }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-ink">{v.model}</span>
                    {sel && <Check size={13} className="shrink-0 text-accent" />}
                  </div>
                  <div className="microlabel mt-0.5">{v.title}</div>
                </button>
              )
            })}
          </div>

          {vendor && (
            <>
              <div>
                <div className="microlabel mb-1">{t('conn.name')}</div>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${vendor.model} · west wing`} className="mono h-auto bg-surface-2 py-1.5 text-[12px]" />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[...vendor.identity, ...vendor.fields].map((f) => (
                  <FieldInput key={f.key} f={f} value={cfg[f.key] ?? ''} onChange={(v) => setField(f.key, v)} />
                ))}
              </div>

              {/* robot camera streams (rtsp) */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="microlabel">{t('conn.streams')}</span>
                  <Button variant="outline" size="sm" onClick={() => setStreams((s) => [...s, { name: '', url: '', kind: 'camera' }])} className="mono h-auto px-2 py-0.5 text-[10px] normal-case tracking-[0.1em]">
                    + {t('conn.addStream')}
                  </Button>
                </div>
                {streams.map((s, i) => (
                  <div key={i} className="mb-1.5 flex items-center gap-1.5">
                    <Input value={s.name} onChange={(e) => setStreams((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder={t('conn.streamName')} className="mono h-auto w-32 bg-surface-2 py-1.5 text-[11.5px]" />
                    <Input value={s.url} onChange={(e) => setStreams((all) => all.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} placeholder="rtsp://user:pass@10.0.0.9:554/ch1" className="mono h-auto min-w-0 flex-1 bg-surface-2 py-1.5 text-[11.5px]" />
                    <Select value={s.kind} onValueChange={(v) => setStreams((all) => all.map((x, j) => (j === i ? { ...x, kind: v } : x)))}>
                      <SelectTrigger size="sm" className="mono w-28 bg-surface-2 text-[11px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="camera">camera</SelectItem>
                        <SelectItem value="thermal">thermal</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="iconSm" onClick={() => setStreams((all) => all.filter((_, j) => j !== i))} aria-label="remove stream">
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
                <div className="text-[10.5px] leading-snug text-ink-3">{t('conn.streamsHint')}</div>
              </div>

              {err && <div className="mono border border-crit/40 bg-crit/10 px-2.5 py-1.5 text-[12px]" style={{ color: 'var(--color-crit)' }}>{err}</div>}
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" onClick={onClose} className="mono h-auto px-3 py-1.5 text-[11px]">{t('c.cancel')}</Button>
          <Button variant="signal" disabled={!vendor || busy} onClick={create} className="mono h-auto px-4 py-1.5 text-[11px] disabled:opacity-30">
            {t('conn.create')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ConnectorLogsModal({ siteId, connector, onClose }: { siteId: string; connector: Connector; onClose: () => void }) {
  const t = useT()
  const [lines, setLines] = useState<string[]>([])
  const load = useCallback(() => {
    api.connectorLogs(siteId, connector.id).then((d: { lines?: string[] }) => setLines(d.lines ?? [])).catch(() => {})
  }, [siteId, connector.id])
  useEffect(() => {
    load()
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  }, [load])
  return (
    <Modal onClose={onClose} wide title={t('conn.logs')}>
      <div className="flex max-h-[80dvh] flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="microlabel">{connector.name} · {t('conn.logs')}</span>
          <Button variant="ghost" size="iconSm" onClick={onClose} aria-label="close"><X size={16} /></Button>
        </div>
        <pre className="mono min-h-40 flex-1 overflow-auto bg-black/40 p-3 text-[10.5px] leading-relaxed text-ink-2">
          {lines.length ? lines.join('\n') : t('conn.noLogs')}
        </pre>
      </div>
    </Modal>
  )
}
