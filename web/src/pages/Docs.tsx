import { useEffect, useId, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Book as BookOpen, ChevronRight, Chip as Cpu, Download, Launch as ExternalLink, Key as KeyRound, Plug, Application as Puzzle } from '@carbon/icons-react'
import { apiFetch } from '../lib/store'
import { BASE } from '../lib/base'
import { useT, useLang } from '../lib/i18n'
import { Panel } from '../components/ui'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

// The API reference renders live from the two OpenAPI specs the platform
// serves, so it can never drift from the running server. The guide above it is
// the human-facing "how do I connect / embed" summary.

interface OpenAPIOp {
  summary?: string
  description?: string
  tags?: string[]
  security?: unknown[]
}
interface OpenAPISpec {
  info?: { title?: string; version?: string; description?: string }
  tags?: { name: string; description?: string }[]
  paths?: Record<string, Record<string, OpenAPIOp>>
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const METHOD_COLOR: Record<string, string> = {
  get: 'var(--color-ok)',
  post: 'var(--color-accent)',
  put: 'var(--color-warn)',
  patch: 'var(--color-warn)',
  delete: 'var(--color-crit)',
}

type Row = { method: string; path: string; op: OpenAPIOp }

function useSpec(url: string) {
  const [spec, setSpec] = useState<OpenAPISpec | null>(null)
  const [err, setErr] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let dead = false
    setSpec(null)
    setErr(false)
    apiFetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((s) => !dead && setSpec(s))
      .catch(() => !dead && setErr(true))
    return () => {
      dead = true
    }
  }, [url, revision])
  return { spec, err, retry: () => setRevision((n) => n + 1) }
}

/** group a spec's operations by their first tag, preserving the spec's tag order */
function grouped(spec: OpenAPISpec | null): { tag: string; desc?: string; rows: Row[] }[] {
  if (!spec?.paths) return []
  const byTag = new Map<string, Row[]>()
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const m of METHODS) {
      const op = ops[m]
      if (!op) continue
      const tag = op.tags?.[0] ?? 'other'
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag)!.push({ method: m, path, op })
    }
  }
  const order = (spec.tags ?? []).map((t) => t.name)
  const tags = [...byTag.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b)
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
  })
  return tags.map((tag) => ({
    tag,
    desc: spec.tags?.find((t) => t.name === tag)?.description,
    rows: byTag.get(tag)!,
  }))
}

function MethodBadge({ method }: { method: string }) {
  return (
    <span
      className="mono inline-block w-[52px] shrink-0 text-center text-[12px] font-semibold uppercase tracking-normal"
      style={{ color: METHOD_COLOR[method] ?? 'var(--color-ink-2)' }}
    >
      {method}
    </span>
  )
}

function EndpointRow({ row }: { row: Row }) {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const zh = useLang((s) => s.lang === 'zh')
  const hasDetail = !!row.op.description
  const publicEp = Array.isArray(row.op.security) && row.op.security.length === 0
  return (
    <div className="border-b border-line/50 last:border-0">
      <Button variant="ghost"
        onClick={() => hasDetail && setOpen((o) => !o)}
        disabled={!hasDetail}
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? detailId : undefined}
        className="flex h-auto w-full min-w-0 items-start justify-start gap-2 whitespace-normal px-3 py-3 text-left disabled:opacity-100"
      >
        <MethodBadge method={row.method} />
        <span className="min-w-0 flex-1">
          <code className="mono block break-all text-[12px] text-ink">{row.path}</code>
          {row.op.summary && <span className="mt-1 block break-words text-sm font-normal text-ink-3">{row.op.summary}</span>}
        </span>
        {publicEp && <span className="shrink-0 border border-line px-1 text-[12px] text-ink-2">{zh ? '公开' : 'Public'}</span>}
        {hasDetail && <ChevronRight size={13} className={`ml-auto shrink-0 text-ink-3 transition-transform ${open ? 'rotate-90' : ''} ${publicEp ? '' : 'ml-auto'}`} />}
      </Button>
      {open && row.op.description && (
        <div id={detailId} className="break-words border-t border-line/40 bg-surface-2/40 px-3 py-3 text-sm leading-relaxed text-ink-2 sm:pl-[76px]">
          {row.op.description}
        </div>
      )}
    </div>
  )
}

function SpecBrowser({ url }: { url: string }) {
  const { spec, err, retry } = useSpec(url)
  const t = useT()
  const zh = useLang((s) => s.lang === 'zh')
  const groups = useMemo(() => grouped(spec), [spec])
  if (err) return <div role="alert" className="flex min-h-40 flex-col items-start justify-center gap-3 border border-line p-4 text-sm text-ink-2">
    <p>{zh ? '接口规范加载失败，请重试。' : 'The API specification could not be loaded. Retry to reconnect.'}</p>
    <Button variant="outline" onClick={retry}>{t('c.refresh')}</Button>
  </div>
  if (!spec) return <div role="status" className="flex min-h-40 items-center border border-line p-4 text-sm text-ink-3">{t('c.loading')}…</div>
  const count = groups.reduce((n, g) => n + g.rows.length, 0)
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[14px] font-medium text-ink">{spec.info?.title}</div>
          <div className="text-[12px] text-ink-3">{count} {zh ? '个接口' : 'endpoints'} · OpenAPI {spec.info?.version}</div>
        </div>
        <a
          href={BASE + url}
          target="_blank"
          rel="noreferrer"
          className="mono flex items-center gap-1.5 border border-line-2 px-2 py-1 text-[12px] tracking-normal text-ink-3 transition-colors hover:text-ink-2"
        >
          <Download size={12} /> JSON
        </a>
      </div>
      <div className="space-y-3">
        {groups.map((g) => (
          <Panel key={g.tag} className="overflow-hidden p-0">
            <div className="flex items-baseline gap-2 border-b border-line bg-surface-2/60 px-3 py-2">
              <span className="text-sm font-medium text-ink">{g.tag}</span>
              {g.desc && <span className="truncate text-[12px] text-ink-3">{g.desc}</span>}
            </div>
            {g.rows.map((r) => (
              <EndpointRow key={`${r.method}-${r.path}`} row={r} />
            ))}
          </Panel>
        ))}
      </div>
    </div>
  )
}

function GuideCard({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <Panel className="p-4">
      <div className="mb-2 flex items-center gap-2 text-ink">
        <Icon size={15} className="text-ink-3" />
        <span className="text-[14px] font-medium">{title}</span>
      </div>
      <div className="space-y-1.5 text-[14px] leading-relaxed text-ink-2">{children}</div>
    </Panel>
  )
}

export function Docs() {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const zh = lang === 'zh'
  const [face, setFace] = useState<'integration' | 'platform'>('integration')

  return (
    <div className="mx-auto h-full max-w-[1000px] overflow-y-auto px-4 py-5 md:px-6">
      <div className="mb-5 flex items-center gap-3">
        <BookOpen size={22} className="text-ink-2" />
        <div>
          <h1 className="text-2xl font-medium text-ink">{t('docs.title')}</h1>
          <p className="text-[14px] text-ink-3">{t('docs.sub')}</p>
        </div>
      </div>

      {/* --- integration guide --- */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <GuideCard icon={Plug} title={zh ? '两种接入模式' : 'Two ways to connect'}>
          <p>{zh
            ? '托管连接器：平台在 INTEG 面板代跑官方 adapter（选厂商、填地址/凭证/相机 rtsp），适合平台能直连机器人网络。'
            : 'Managed connector: the platform runs the official adapter for you (pick vendor, enter address / credentials / camera rtsp) — when it can reach the robot network.'}</p>
          <p>{zh
            ? '外部 adapter：签发场站 API Key，用 HTTP 契约自建，适合跨网或内置三型号之外的机器人。'
            : 'External adapter: issue a site API key and build against the HTTP contract — for cross-network or any other model.'}</p>
          <Link to="/robots" className="mono inline-flex items-center gap-1 pt-0.5 text-[12px] tracking-normal text-ink-3 hover:text-ink-2">
            {zh ? '接入向导' : 'Connect wizard'} <ChevronRight size={11} />
          </Link>
        </GuideCard>

        <GuideCard icon={Cpu} title={zh ? 'adapter SDK 双形态' : 'Adapter SDK, two flavors'}>
          <p>{zh
            ? 'TypeScript @plantbot/adapter-sdk（零依赖，约 50 行接一台机器人）与 Node-RED 四节点包，南向随意接 Modbus / MQTT / OPC UA。'
            : 'TypeScript @plantbot/adapter-sdk (zero-dep, ~50 lines per robot) and a Node-RED four-node package — southbound speaks Modbus / MQTT / OPC UA.'}</p>
          <p className="mono text-[12px] text-ink-3">sdk/adapter-sdk-ts · sdk/node-red-contrib-plantbot</p>
        </GuideCard>

        <GuideCard icon={Puzzle} title={zh ? '嵌入你的系统 (iframe)' : 'Embed in your app (iframe)'}>
          <p><code className="mono text-[12px] text-ink">?embed=1</code> {zh ? '无壳嵌入（保留紧凑模块导航）。' : 'chrome-less embed (keeps a compact module nav).'}</p>
          <p><code className="mono text-[12px] text-ink">?site=</code> {zh ? '钉定场站' : 'pins the site'} · <code className="mono text-[12px] text-ink">?embednav=top|bottom|hidden</code> {zh ? '控制导航条位置。' : 'positions the nav strip.'}</p>
          <p>{zh ? '跨站需 PB_COOKIE_SAMESITE=none（HTTPS）+ CSP frame-ancestors 白名单。' : 'Cross-site needs PB_COOKIE_SAMESITE=none (HTTPS) + a CSP frame-ancestors allowlist.'}</p>
        </GuideCard>

        <GuideCard icon={KeyRound} title={zh ? '统一身份 (OIDC SSO)' : 'Single sign-on (OIDC)'}>
          <p>{zh
            ? '设 OIDC_ISSUER + OIDC_CLIENT_ID 即启用授权码+PKCE 登录，首次登录 JIT 建号，角色由 OIDC_DEFAULT_ROLE / OIDC_ADMIN_USERS 决定。'
            : 'Set OIDC_ISSUER + OIDC_CLIENT_ID to enable Authorization Code + PKCE sign-in; users are JIT-provisioned, roles from OIDC_DEFAULT_ROLE / OIDC_ADMIN_USERS.'}</p>
        </GuideCard>
      </div>

      {/* --- live API reference --- */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[15px] font-medium text-ink">{t('docs.apiRef')}</h2>
          <a
            href={`${BASE}/api-docs.html`}
            target="_blank"
            rel="noreferrer"
            className="mono flex items-center gap-1 text-[12px] tracking-normal text-ink-3 transition-colors hover:text-(--signal)"
          >
            {zh ? '完整交互文档 (Redoc)' : 'Full reference (Redoc)'} <ExternalLink size={11} />
          </a>
        </div>
        <ToggleGroup type="single" value={face} onValueChange={(v) => v && setFace(v as typeof face)}>
          <ToggleGroupItem value="integration" className="mono px-2.5 py-1.5 text-[12px] tracking-normal">
            {zh ? '集成面 (Bearer key)' : 'Integration (Bearer key)'}
          </ToggleGroupItem>
          <ToggleGroupItem value="platform" className="mono px-2.5 py-1.5 text-[12px] tracking-normal">
            {zh ? '会话面 (Cookie)' : 'Platform (Cookie)'}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <p className="mb-4 text-[14px] leading-relaxed text-ink-3">
        {face === 'integration'
          ? (zh ? '机器人上报 + 只读运营数据，用场站 API Key（Authorization: Bearer pbk_…）。' : 'Robot reporting + read-only operational data, authorized with a site API key (Authorization: Bearer pbk_…).')
          : (zh ? '控制台的全部会话面操作，用登录 Cookie（含 SSO）。' : 'Every console operation, authorized with the login session cookie (SSO included).')}
      </p>

      {face === 'integration'
        ? <SpecBrowser url="/api/integration/v1/openapi.json" />
        : <SpecBrowser url="/api/openapi.json" />}

      <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
        <a href="https://github.com/supcon-international/plantbot/blob/main/docs/integration.md" target="_blank" rel="noreferrer"
           className="mono flex items-center gap-1.5 border border-line-2 px-2.5 py-1.5 text-[12px] tracking-normal text-ink-3 hover:text-ink-2">
          integration.md <ExternalLink size={11} />
        </a>
        <a href="https://github.com/supcon-international/plantbot/tree/main/.claude/skills/robot-adapter" target="_blank" rel="noreferrer"
           className="mono flex items-center gap-1.5 border border-line-2 px-2.5 py-1.5 text-[12px] tracking-normal text-ink-3 hover:text-ink-2">
          robot-adapter skill <ExternalLink size={11} />
        </a>
      </div>
    </div>
  )
}
