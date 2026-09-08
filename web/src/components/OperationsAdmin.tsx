import { useEffect, useState } from 'react'
import { Building2, ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { apiFetch, useApp } from '../lib/store'
import { useLang } from '../lib/i18n'
import { useConfirm } from './ConfirmDialog'
import { EmptyNote, Modal, Panel, PanelHead } from './ui'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

type Unit = {
  id: string
  name: string
  kind: 'factory' | 'department' | 'position'
  parentId?: string
  siteId?: string
}
type Member = { username: string; departmentId?: string; positionId?: string }
type Directory = { units: Unit[]; members: Member[]; users: { username: string; displayName: string }[] }
const useLabels = () => {
  const zh = useLang((s) => s.lang) === 'zh'
  return (en: string, cn: string) => (zh ? cn : en)
}
const json = async (path: string, init?: RequestInit) => {
  const r = await apiFetch(path, init)
  const body = await r.json()
  if (!r.ok) throw new Error(body.error ?? r.statusText)
  return body
}
const request = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const date = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
function Picker({
  value,
  onChange,
  options,
  label,
}: {
  value: string
  onChange: (value: string) => void
  options: { id: string; name: string }[]
  label: string
}) {
  const l = useLabels()
  return (
    <div>
      <Label>{label}</Label>
      <Select value={value || 'none'} onValueChange={(v) => onChange(v === 'none' ? '' : v)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{l('None', '无')}</SelectItem>
          {options.map((o) => (
            <SelectItem value={o.id} key={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
function UnitForm({
  unit,
  units,
  onClose,
  onSaved,
}: {
  unit: Unit | null
  units: Unit[]
  onClose: () => void
  onSaved: () => void
}) {
  const l = useLabels(),
    sites = useApp((s) => s.sites)
  const [name, setName] = useState(unit?.name ?? ''),
    [kind, setKind] = useState<Unit['kind']>(unit?.kind ?? 'department'),
    [parentId, setParentId] = useState(unit?.parentId ?? ''),
    [siteId, setSiteId] = useState(unit?.siteId ?? '')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await json(
        `/api/organization/units${unit ? `/${unit.id}` : ''}`,
        request(unit ? 'PATCH' : 'POST', { name, kind, parentId, siteId }),
      )
      onSaved()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={unit ? l('Edit organization unit', '编辑组织条目') : l('New organization unit', '新建组织条目')}
      onClose={onClose}
    >
      <div className="space-y-3 p-4">
        <div>
          <Label htmlFor="org-name">{l('Name', '名称')}</Label>
          <Input id="org-name" autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>{l('Type', '类型')}</Label>
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v as Unit['kind'])
              setParentId('')
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                ['factory', l('Factory', '工厂')],
                ['department', l('Department', '部门')],
                ['position', l('Position', '岗位')],
              ].map(([id, n]) => (
                <SelectItem key={id} value={id}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {kind !== 'factory' && (
          <Picker
            label={l('Parent unit', '上级组织')}
            value={parentId}
            onChange={setParentId}
            options={units.filter((u) => u.id !== unit?.id && u.kind !== 'position')}
          />
        )}
        <Picker label={l('Related site', '关联场站')} value={siteId} onChange={setSiteId} options={sites} />
        <p className="text-xs text-ink-3">
          {l(
            'Organization metadata does not grant access. User roles control site permissions.',
            '组织归属仅用于管理；访问权限由用户的场站角色决定。',
          )}
        </p>
        {error && (
          <p className="text-xs text-crit" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={onClose}>
            {l('Cancel', '取消')}
          </Button>
          <Button variant="signal" disabled={!name.trim() || busy} onClick={save}>
            {busy ? l('Saving…', '正在保存…') : l('Save', '保存')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
function MemberForm({
  member,
  directory,
  onClose,
  onSaved,
}: {
  member: Member
  directory: Directory
  onClose: () => void
  onSaved: () => void
}) {
  const l = useLabels(),
    [departmentId, setDepartment] = useState(member.departmentId ?? ''),
    [positionId, setPosition] = useState(member.positionId ?? ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await json(
        `/api/organization/members/${encodeURIComponent(member.username)}`,
        request('PUT', { departmentId, positionId }),
      )
      onSaved()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={`${l('User organization', '用户归属')} · ${member.username}`} onClose={onClose}>
      <div className="space-y-3 p-4">
        <Picker
          label={l('Department', '部门')}
          value={departmentId}
          onChange={setDepartment}
          options={directory.units.filter((u) => u.kind === 'department')}
        />
        <Picker
          label={l('Position', '岗位')}
          value={positionId}
          onChange={setPosition}
          options={directory.units.filter((u) => u.kind === 'position')}
        />
        {error && (
          <p role="alert" className="text-crit text-xs">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={onClose}>
            {l('Cancel', '取消')}
          </Button>
          <Button variant="signal" disabled={busy} onClick={save}>
            {l('Save', '保存')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
function Organization() {
  const l = useLabels(),
    confirm = useConfirm(),
    sites = useApp((s) => s.sites)
  const [directory, setDirectory] = useState<Directory>({ units: [], members: [], users: [] }),
    [unit, setUnit] = useState<Unit | null | undefined>(undefined),
    [member, setMember] = useState<Member | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true)
  const load = () => {
    setBusy(true)
    setError('')
    json('/api/organization/units')
      .then(setDirectory)
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false))
  }
  useEffect(load, [])
  const name = (id?: string) => directory.units.find((u) => u.id === id)?.name ?? '—'
  const kind = (k: string) =>
    k === 'factory' ? l('Factory', '工厂') : k === 'department' ? l('Department', '部门') : l('Position', '岗位')
  return (
    <div className="space-y-3">
      <Panel>
        <PanelHead
          label={l('Factory, departments and positions', '工厂、部门与岗位')}
          right={
            <Button variant="outline" size="sm" onClick={() => setUnit(null)}>
              <Plus size={12} />
              {l('Add unit', '新增条目')}
            </Button>
          }
        />
        <p className="px-3 pt-3 text-xs text-ink-3">
          {l(
            'Use a small organization directory alongside site-based roles. Assign users below; manage their access in the user table above.',
            '用组织目录管理人员归属，上方用户表管理场站访问权限。',
          )}
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{l('Name', '名称')}</TableHead>
              <TableHead>{l('Type', '类型')}</TableHead>
              <TableHead>{l('Parent', '上级')}</TableHead>
              <TableHead>{l('Site', '场站')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {directory.units.map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.name}</TableCell>
                <TableCell>{kind(u.kind)}</TableCell>
                <TableCell>{name(u.parentId)}</TableCell>
                <TableCell>{sites.find((s) => s.id === u.siteId)?.name ?? '—'}</TableCell>
                <TableCell>
                  <span className="flex justify-end gap-1">
                    <Button variant="ghost" size="iconSm" title={l('Edit unit', '编辑条目')} onClick={() => setUnit(u)}>
                      <Pencil size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="iconSm"
                      title={l('Delete unit', '删除条目')}
                      onClick={async () => {
                        if (
                          !(await confirm({
                            message: l(
                              `Delete ${u.name}? Units with children or members must be cleared first.`,
                              `删除 ${u.name}？有下级或成员的条目需要先解除关联。`,
                            ),
                            destructive: true,
                          }))
                        )
                          return
                        try {
                          await json(`/api/organization/units/${u.id}`, { method: 'DELETE' })
                          load()
                        } catch (e) {
                          setError(String(e))
                        }
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
        {!busy && !directory.units.length && (
          <EmptyNote>
            {l(
              'Add a factory or department to organize people across sites.',
              '新增工厂或部门，管理跨场站的人员归属。',
            )}
          </EmptyNote>
        )}
      </Panel>
      <Panel>
        <PanelHead label={l('User assignments', '用户归属')} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{l('User', '用户')}</TableHead>
              <TableHead>{l('Department', '部门')}</TableHead>
              <TableHead>{l('Position', '岗位')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {directory.users.map((u) => {
              const m = directory.members.find((x) => x.username === u.username) ?? { username: u.username }
              return (
                <TableRow key={u.username}>
                  <TableCell>
                    {u.displayName} <span className="mono text-xs text-ink-3">{u.username}</span>
                  </TableCell>
                  <TableCell>{name(m.departmentId)}</TableCell>
                  <TableCell>{name(m.positionId)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setMember(m)}>
                      {l('Assign', '设置归属')}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Panel>
      {busy && (
        <p className="text-xs text-ink-3" role="status">
          {l('Loading directory…', '正在读取组织目录…')}
        </p>
      )}
      {error && (
        <p className="text-sm text-crit" role="alert">
          {error}{' '}
          <Button variant="ghost" size="sm" onClick={load}>
            {l('Retry', '重试')}
          </Button>
        </p>
      )}
      {unit !== undefined && (
        <UnitForm
          unit={unit}
          units={directory.units}
          onClose={() => setUnit(undefined)}
          onSaved={() => {
            setUnit(undefined)
            load()
          }}
        />
      )}
      {member && (
        <MemberForm
          member={member}
          directory={directory}
          onClose={() => setMember(null)}
          onSaved={() => {
            setMember(null)
            load()
          }}
        />
      )}
    </div>
  )
}
function AuditLog() {
  const l = useLabels(),
    [kind, setKind] = useState('all'),
    [actor, setActor] = useState(''),
    [from, setFrom] = useState(date(new Date(Date.now() - 7 * 86_400_000))),
    [to, setTo] = useState(date(new Date())),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{
      logs: { id: number; ts: number; actor: string; action: string; siteId?: string; target: string; status: number }[]
      total: number
    }>({ logs: [], total: 0 }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true)
    setError('')
    const end = new Date(`${to}T00:00:00`)
    end.setDate(end.getDate() + 1)
    const q = new URLSearchParams({
      from: String(new Date(`${from}T00:00:00`).getTime()),
      to: String(end.getTime()),
      kind,
      offset: String(offset),
      limit: '25',
      ...(actor ? { actor } : {}),
    })
    json(`/api/audit-log?${q}`, { signal: controller.signal })
      .then(setResult)
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [kind, actor, from, to, offset, revision])
  return (
    <Panel>
      <PanelHead
        label={l('Login and operation logs', '登录与操作日志')}
        right={
          <Button
            variant="ghost"
            size="iconSm"
            aria-label={l('Refresh logs', '刷新日志')}
            onClick={() => setRevision((x) => x + 1)}
            disabled={busy}
          >
            <RefreshCw size={13} />
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-3 p-3">
        <div>
          <Label>{l('From', '开始日期')}</Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value)
              setOffset(0)
            }}
          />
        </div>
        <div>
          <Label>{l('Through', '结束日期')}</Label>
          <Input
            type="date"
            value={to}
            min={from}
            onChange={(e) => {
              setTo(e.target.value)
              setOffset(0)
            }}
          />
        </div>
        <div>
          <Label>{l('User', '用户')}</Label>
          <Input
            value={actor}
            placeholder={l('All users', '全部用户')}
            onChange={(e) => {
              setActor(e.target.value)
              setOffset(0)
            }}
          />
        </div>
        <div>
          <Label>{l('Log type', '日志类型')}</Label>
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v)
              setOffset(0)
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                ['all', l('All', '全部')],
                ['login', l('Login', '登录')],
                ['operation', l('Operation', '操作')],
              ].map(([v, n]) => (
                <SelectItem key={v} value={v}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="px-3 pb-3 text-xs text-ink-3">
        {l(
          'Server-recorded requests and outcomes, retained for 90 days. Passwords, keys, request bodies and session cookies are never stored here.',
          '记录服务端实际请求与执行状态，保留 90 天，不记录密码、密钥、请求正文或会话 Cookie。',
        )}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{l('Time', '时间')}</TableHead>
            <TableHead>{l('User', '用户')}</TableHead>
            <TableHead>{l('Action', '操作')}</TableHead>
            <TableHead>{l('Site / target', '场站 / 对象')}</TableHead>
            <TableHead>{l('Result', '结果')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.logs.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="mono text-xs whitespace-nowrap">{new Date(r.ts).toLocaleString()}</TableCell>
              <TableCell>{r.actor}</TableCell>
              <TableCell className="mono text-[11px]">{r.action}</TableCell>
              <TableCell>{[r.siteId, r.target].filter(Boolean).join(' · ') || '—'}</TableCell>
              <TableCell className={r.status >= 400 ? 'text-warn' : 'text-ink-2'}>
                {r.status} · {r.status >= 400 ? l('Rejected', '未成功') : l('Success', '成功')}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!busy && !result.logs.length && (
        <EmptyNote>{l('No logs match these filters.', '没有符合筛选条件的日志。')}</EmptyNote>
      )}
      {error && (
        <p className="p-3 text-xs text-crit" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="p-3 text-xs text-ink-3">
          {l('Loading logs…', '正在读取日志…')}
        </p>
      )}
      <div className="flex justify-between items-center border-t border-line p-3 text-xs">
        <span>
          {result.total} {l('records', '条记录')}
        </span>
        <span className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="iconSm"
            aria-label={l('Previous logs', '上一页日志')}
            disabled={!offset || busy}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            <ChevronLeft size={13} />
          </Button>
          {Math.floor(offset / 25) + 1} / {Math.max(1, Math.ceil(result.total / 25))}
          <Button
            variant="ghost"
            size="iconSm"
            aria-label={l('Next logs', '下一页日志')}
            disabled={offset + 25 >= result.total || busy}
            onClick={() => setOffset(offset + 25)}
          >
            <ChevronRight size={13} />
          </Button>
        </span>
      </div>
    </Panel>
  )
}
export function OperationsAdmin() {
  const l = useLabels(),
    [tab, setTab] = useState('organization')
  return (
    <div className="space-y-3">
      <ToggleGroup type="single" value={tab} onValueChange={(v) => v && setTab(v)}>
        <ToggleGroupItem value="organization" className="gap-2">
          <Building2 size={13} />
          {l('Organization', '组织管理')}
        </ToggleGroupItem>
        <ToggleGroupItem value="audit" className="gap-2">
          <ShieldCheck size={13} />
          {l('Audit logs', '运维日志')}
        </ToggleGroupItem>
      </ToggleGroup>
      {tab === 'organization' ? <Organization /> : <AuditLog />}
    </div>
  )
}
