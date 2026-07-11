// Platform administration — sites and accounts. The delivery-engineer home:
// create a site here, then model it in the Site Builder (/sites/:id).
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Plus, MapPinned, Users as UsersIcon, Trash2, KeyRound, ArrowUpRight } from 'lucide-react'
import { useApp, useSite, api, reconnectRealtime } from '../lib/store'
import { useT } from '../lib/i18n'
import { Panel, PanelHead, Modal } from '../components/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)

function NewSiteModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [operator, setOperator] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const id = slug(name)

  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setErr('')
    const r = await api.createSite({ name: name.trim(), operator: operator.trim() || undefined })
    setBusy(false)
    if (r.site?.id) {
      onCreated(r.site.id)
    } else {
      setErr(r.error ?? 'failed')
    }
  }

  return (
    <Modal onClose={onClose} title={t('sb.newSite')}>
      <div className="space-y-3.5 p-4">
        <div className="microlabel">{t('sb.newSite')}</div>
        <div>
          <Label className="mb-1.5">{t('sb.siteName')}</Label>
          <Input
            autoFocus
            className="bg-surface-2 py-2 text-[13px]"
            placeholder={t('sb.siteNamePh')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          {id && <div className="mono mt-1 text-[10.5px] text-ink-3">id: {id}</div>}
        </div>
        <div>
          <Label className="mb-1.5">{t('sb.operator')}</Label>
          <Input className="bg-surface-2 py-2 text-[13px]" placeholder="Plantbot Operations" value={operator} onChange={(e) => setOperator(e.target.value)} />
        </div>
        {err && <div className="mono text-[11.5px] text-crit">{err}</div>}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={onClose} className="mono text-[11.5px] normal-case tracking-[0.1em]">
            {t('c.cancel')}
          </Button>
          <Button variant="signal" disabled={!name.trim() || busy} onClick={submit} className="mono text-[11.5px] normal-case tracking-[0.12em] disabled:opacity-40">
            {busy ? '…' : t('sb.create')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- users ----------

interface UserRow {
  username: string
  displayName: string
  roles: Record<string, string>
  seeded: boolean
}

function UserModal({ user, onClose, onSaved }: { user: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const sites = useApp((s) => s.sites)
  const [username, setUsername] = useState(user?.username ?? '')
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [password, setPassword] = useState('')
  const curScope = user ? (Object.keys(user.roles)[0] ?? '*') : '*'
  const curRole = user ? (Object.values(user.roles)[0] ?? 'viewer') : 'operator'
  const [scope, setScope] = useState(curScope)
  const [role, setRole] = useState(curRole)
  const [err, setErr] = useState('')

  const submit = async () => {
    setErr('')
    const roles = { [scope]: role }
    const r = user
      ? await api.patchUser(user.username, { displayName, roles, ...(password ? { password } : {}) })
      : await api.createUser({ username, displayName: displayName || username, password, roles })
    if (r.user) onSaved()
    else setErr(r.error ?? 'failed')
  }

  return (
    <Modal onClose={onClose} title={t(user ? 'users.edit' : 'users.new')}>
      <div className="space-y-3 p-4">
        <div className="microlabel">{t(user ? 'users.edit' : 'users.new')}</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="mb-1.5">{t('login.user')}</Label>
            <Input className="mono bg-surface-2 py-2 text-[13px]" value={username} disabled={!!user} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1.5">{t('users.display')}</Label>
            <Input className="bg-surface-2 py-2 text-[13px]" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="mb-1.5">{t('users.scope')}</Label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="mono w-full bg-surface-2 text-[12px] normal-case tracking-normal">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="*">{t('users.allSites')}</SelectItem>
                {sites.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1.5">{t('users.role')}</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="mono w-full bg-surface-2 text-[12px] normal-case tracking-normal">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['viewer', 'operator', 'admin'].map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label className="mb-1.5">{t(user ? 'users.newPass' : 'login.pass')}</Label>
          <Input
            type="password"
            className="mono bg-surface-2 py-2 text-[13px]"
            placeholder={user ? t('users.keepPass') : '≥ 8 chars'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {err && <div className="mono text-[11.5px] text-crit">{err}</div>}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={onClose} className="mono text-[11.5px] normal-case tracking-[0.1em]">
            {t('c.cancel')}
          </Button>
          <Button
            variant="signal"
            disabled={!username || (!user && password.length < 8)}
            onClick={submit}
            className="mono text-[11.5px] normal-case tracking-[0.12em] disabled:opacity-40"
          >
            {t('sb.save')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function UsersPanel() {
  const t = useT()
  const [users, setUsers] = useState<UserRow[]>([])
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [creating, setCreating] = useState(false)
  const load = () => api.listUsers().then((r) => setUsers(r.users ?? []))
  useEffect(() => {
    load()
  }, [])

  return (
    <Panel className="rise rise-2">
      <PanelHead
        label={
          <span className="flex items-center gap-2">
            <UsersIcon size={13} /> {t('users.title')}
          </span>
        }
        right={
          <Button variant="outline" size="sm" onClick={() => setCreating(true)} className="mono h-auto gap-1 px-2 py-1 text-[10.5px] normal-case tracking-[0.1em]">
            <Plus size={11} /> {t('users.new')}
          </Button>
        }
      />
      <Table>
        <TableHeader>
          <TableRow className="border-line">
            <TableHead className="px-3.5">{t('login.user')}</TableHead>
            <TableHead>{t('users.display')}</TableHead>
            <TableHead>{t('users.role')}</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.username} className="border-line/60 last:border-0">
              <TableCell className="mono px-3.5 py-2.5 text-[12.5px] text-ink">{u.username}</TableCell>
              <TableCell className="py-2.5 text-[12.5px] text-ink-2">{u.displayName}</TableCell>
              <TableCell className="py-2.5">
                <span className="flex flex-wrap gap-1">
                  {Object.entries(u.roles).map(([sc, r]) => (
                    <Badge key={sc} variant="outline" className="mono text-[9.5px] tracking-[0.08em]">
                      {sc === '*' ? t('users.allSites') : sc} · {r}
                    </Badge>
                  ))}
                  {u.seeded && <Badge variant="outline" className="mono text-[9.5px] tracking-[0.08em] opacity-60">seed</Badge>}
                </span>
              </TableCell>
              <TableCell className="py-2.5">
                <span className="flex justify-end gap-1 pr-2">
                  <Button variant="ghost" size="iconSm" onClick={() => setEditing(u)} title={t('users.edit')}>
                    <KeyRound size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="iconSm"
                    className="text-ink-3 hover:text-crit"
                    title={t('c.delete')}
                    onClick={async () => {
                      if (!confirm(t('users.deleteConfirm').replace('{u}', u.username))) return
                      await api.deleteUser(u.username)
                      load()
                    }}
                  >
                    <Trash2 size={13} />
                  </Button>
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {creating && <UserModal user={null} onClose={() => setCreating(false)} onSaved={() => (setCreating(false), load())} />}
      {editing && <UserModal user={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />}
    </Panel>
  )
}

// ---------- sites ----------

export function Sites() {
  const t = useT()
  const nav = useNavigate()
  const sites = useApp((s) => s.sites)
  const setSite = useSite((s) => s.setSite)
  const [creating, setCreating] = useState(false)

  const refresh = () => api.listSites().then(({ sites }) => useApp.setState({ sites }))

  const cards = useMemo(() => sites, [sites])

  return (
    <div className="mx-auto max-w-[1300px] space-y-4 p-3 md:p-4">
      <div className="flex items-center justify-between">
        <div className="mono text-[14px] text-ink-2">
          {sites.length} {t('sb.sitesCount')}
        </div>
        <Button variant="signal" onClick={() => setCreating(true)} className="mono text-[11.5px] normal-case tracking-[0.12em]">
          <Plus size={13} /> {t('sb.newSite')}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((s, i) => (
          <Panel key={s.id} className={`panel-hover cursor-pointer rise rise-${Math.min(i + 1, 5)}`} onClick={() => nav(`/sites/${s.id}`)}>
            <div className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[15px] font-medium text-ink">{s.name}</div>
                  <div className="microlabel mt-0.5">{s.operator}</div>
                </div>
                <MapPinned size={16} className="shrink-0 text-ink-3" />
              </div>
              <div className="mono flex items-center gap-3 text-[11px] text-ink-3">
                <span>id {s.id}</span>
                <span>{s.robots ?? 0} {t('c.units')}</span>
                {(s.openAlerts ?? 0) > 0 && <span className="text-warn">{s.openAlerts} {t('sb.openAlerts')}</span>}
                {(s as { demo?: boolean }).demo && <Badge variant="outline" className="mono text-[9px]">DEMO</Badge>}
              </div>
              <div className="flex items-center gap-2 border-t border-line/70 pt-2.5">
                <span className="microlabel">{t('sb.openBuilder')}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mono ml-auto h-auto gap-1 px-1.5 py-0.5 text-[10px] normal-case tracking-[0.1em] text-ink-3 hover:text-ink"
                  onClick={(e) => {
                    e.stopPropagation()
                    setSite(s.id)
                    nav('/')
                  }}
                >
                  {t('sb.openConsole')} <ArrowUpRight size={11} />
                </Button>
              </div>
            </div>
          </Panel>
        ))}
      </div>

      <UsersPanel />

      {creating && (
        <NewSiteModal
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false)
            await refresh()
            // join the new site's WS room (setSite's subscriber reconnects;
            // fall back to an explicit reconnect if the id didn't change)
            if (useSite.getState().siteId !== id) setSite(id)
            else reconnectRealtime()
            nav(`/sites/${id}`)
          }}
        />
      )}
    </div>
  )
}
