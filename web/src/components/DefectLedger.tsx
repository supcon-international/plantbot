import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router'
import { Add as Plus, Download } from '@carbon/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyNote, Modal, Panel } from './ui'
import { InspectionField as Field, InspectionHeading, InspectionSelect as Pick } from './InspectionFields'
import { useApp, useCan, useSite } from '../lib/store'
import {
  downloadInspectionCsv,
  inspectionRequest,
  useAssetText,
  useInspectionData,
  type Defect,
  type InspectionAsset,
  type AssetTag,
  type Assignee,
} from '../lib/inspection-assets'
import type { DetectionEvent } from '../lib/types'

type DefectInput = Pick<
  Defect,
  'title' | 'description' | 'assetId' | 'tagId' | 'eventId' | 'severity' | 'category' | 'assignedTo'
>
const blank: DefectInput = {
  title: '',
  description: '',
  assetId: '',
  tagId: '',
  eventId: '',
  severity: 'minor',
  category: 'equipment',
  assignedTo: '',
}
function statusLabel(status: string, l: (en: string, zh: string) => string) {
  return status === 'closed'
    ? l('Closed', '已处理')
    : status === 'in_progress'
      ? l('In progress', '处理中')
      : l('Open', '待处理')
}

function DefectEditor({
  defect,
  event,
  assets,
  tags,
  assignees,
  onClose,
  onSaved,
}: {
  defect: Defect | null
  event?: DetectionEvent
  assets: InspectionAsset[]
  tags: AssetTag[]
  assignees: Assignee[]
  onClose: () => void
  onSaved: () => void
}) {
  const l = useAssetText(),
    op = useCan('operator'),
    site = useSite((s) => s.siteId),
    events = useApp((s) => s.events)
  const [record, setRecord] = useState(defect)
  const [form, setForm] = useState<DefectInput>(
    defect
      ? (Object.fromEntries(Object.keys(blank).map((k) => [k, defect[k as keyof Defect]])) as DefectInput)
      : {
          ...blank,
          ...(event
            ? {
                title: event.label,
                description: event.detail,
                eventId: event.id,
                category: event.category,
                severity: ['critical', 'high'].includes(event.severity) ? ('major' as const) : ('minor' as const),
              }
            : {}),
        },
  )
  const [note, setNote] = useState(''),
    [nextStatus, setNextStatus] = useState<Defect['status']>(defect?.status ?? 'open')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const editable = op && record?.status !== 'closed'
  const set = (key: keyof DefectInput, value: string) => setForm((f) => ({ ...f, [key]: value }))
  const dirty =
    !record || Object.keys(blank).some((k) => form[k as keyof DefectInput] !== record[k as keyof DefectInput])
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const saved = await inspectionRequest<Defect>(
        site,
        `/defects${record ? '/' + record.id : ''}`,
        record ? 'PATCH' : 'POST',
        form,
      )
      setRecord(saved)
      setForm(Object.fromEntries(Object.keys(blank).map((k) => [k, saved[k as keyof Defect]])) as DefectInput)
      setNextStatus(saved.status)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const update = async () => {
    if (!record) return
    setBusy(true)
    setError('')
    try {
      const saved = await inspectionRequest<Defect>(site, `/defects/${record.id}/updates`, 'POST', {
        note,
        status: nextStatus,
      })
      setRecord(saved)
      setNote('')
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const linkedEvent = events.find((e) => e.id === form.eventId)
  const eventOptions = events
    .slice(0, 100)
    .map((e) => ({ value: e.id, label: `${e.label} · ${new Date(e.ts).toLocaleString()}` }))
  if (form.eventId && !eventOptions.some((o) => o.value === form.eventId))
    eventOptions.unshift({ value: form.eventId, label: form.eventId })
  return (
    <Modal wide title={record?.title ?? l('Report defect', '提交缺陷')} onClose={onClose}>
      <InspectionHeading onClose={onClose}>
        {record ? l('Defect record', '缺陷记录') : l('Report defect', '提交缺陷')}
      </InspectionHeading>
      <div className="space-y-4 p-4">
        {record && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <Badge variant="outline">{statusLabel(record.status, l)}</Badge>
            <span className="text-ink-3">
              {l('Submitted by', '提交人')} {record.submittedBy} · {new Date(record.createdAt).toLocaleString()}
            </span>
          </div>
        )}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Field
            label={l('Defect title', '缺陷名称')}
            value={form.title}
            onChange={(v) => set('title', v)}
            required
            disabled={!editable || busy}
          />
          <Field
            label={l('Description', '缺陷描述')}
            value={form.description}
            onChange={(v) => set('description', v)}
            multiline
            disabled={!editable || busy}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Pick
              label={l('Severity', '缺陷等级')}
              value={form.severity}
              onChange={(v) => set('severity', v)}
              disabled={!editable || busy}
              options={[
                { value: 'minor', label: l('Minor', '轻微') },
                { value: 'major', label: l('Major', '严重') },
              ]}
            />
            <Field
              label={l('Category', '分类')}
              value={form.category}
              onChange={(v) => set('category', v)}
              required
              disabled={!editable || busy}
              placeholder={l('Equipment, electrical, environment…', '设备、电气、环境…')}
            />
            <Pick
              label={l('Equipment', '关联设备')}
              value={form.assetId}
              onChange={(v) => {
                set('assetId', v)
                set('tagId', '')
              }}
              disabled={!editable || busy}
              empty={l('Not linked', '未关联')}
              options={assets.map((a) => ({ value: a.id, label: a.name }))}
            />
            <Pick
              label={l('Tag', '关联位号')}
              value={form.tagId}
              onChange={(v) => {
                set('tagId', v)
                const tag = tags.find((t) => t.id === v)
                if (tag) set('assetId', tag.assetId)
              }}
              disabled={!editable || busy}
              empty={l('Not linked', '未关联')}
              options={tags
                .filter((t) => !form.assetId || t.assetId === form.assetId)
                .map((t) => ({ value: t.id, label: t.name }))}
            />
            <Pick
              label={l('Responsible operator', '处理人')}
              value={form.assignedTo}
              onChange={(v) => set('assignedTo', v)}
              disabled={!editable || busy}
              empty={l('Unassigned', '未指派')}
              options={assignees.map((u) => ({ value: u.username, label: `${u.displayName} (${u.username})` }))}
            />
            <Pick
              label={l('Source event', '关联事件')}
              value={form.eventId}
              onChange={(v) => set('eventId', v)}
              disabled={!editable || busy}
              empty={l('Not linked', '未关联')}
              options={eventOptions}
            />
          </div>
          {linkedEvent && (
            <div className="flex items-start gap-3 border border-line p-3">
              {linkedEvent.snapshot && (
                <img
                  src={linkedEvent.snapshot}
                  alt={linkedEvent.label}
                  className="h-16 w-24 object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                  }}
                />
              )}
              <div className="text-sm">
                <div>{linkedEvent.label}</div>
                <div className="text-ink-3">
                  {linkedEvent.sourceName} · {linkedEvent.zone}
                </div>
                <Link to={`/events?ev=${linkedEvent.id}`} onClick={onClose} className="text-link">
                  {l('Review event evidence', '复核事件证据')}
                </Link>
              </div>
            </div>
          )}
          {editable && (
            <div className="flex justify-end">
              <Button
                variant="signal"
                type="submit"
                disabled={busy || !dirty || !form.title.trim() || !form.category.trim()}
              >
                {busy
                  ? l('Saving…', '保存中…')
                  : record
                    ? l('Save details', '保存信息')
                    : l('Submit defect', '提交缺陷')}
              </Button>
            </div>
          )}
        </form>
        {record && (
          <div className="space-y-3 border-t border-line pt-4">
            <h3 className="text-sm font-medium">{l('Treatment history', '处置记录')}</h3>
            {record.resolution && (
              <div className="border border-line bg-surface-2 p-3 text-sm">
                <div className="mb-1 text-ink-3">{l('Closing statement', '关闭说明')}</div>
                <p className="whitespace-pre-wrap">{record.resolution}</p>
              </div>
            )}
            <ol className="space-y-3">
              {record.history.map((h, index) => (
                <li key={index} className="border-l-2 border-line pl-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-1">
                    <span>
                      {h.by}
                      {h.action === 'created'
                        ? ` · ${l('Submitted', '提交')}`
                        : h.action === 'updated'
                          ? ` · ${l('Details updated', '更新信息')}`
                          : h.to && h.to !== h.from
                            ? ` · ${statusLabel(h.to, l)}`
                            : ` · ${l('Note', '备注')}`}
                    </span>
                    <time className="mono text-xs text-ink-3">{new Date(h.at).toLocaleString()}</time>
                  </div>
                  {h.note && <p className="mt-1 whitespace-pre-wrap text-ink-2">{h.note}</p>}
                  {h.changes &&
                    Object.entries(h.changes).map(([key, change]) => (
                      <p key={key} className="mt-1 text-xs text-ink-3">
                        {(
                          {
                            assignedTo: l('Responsible operator', '处理人'),
                            severity: l('Severity', '等级'),
                            category: l('Category', '分类'),
                            title: l('Title', '名称'),
                            description: l('Description', '描述'),
                            assetId: l('Equipment', '设备'),
                            tagId: l('Tag', '位号'),
                            eventId: l('Event', '事件'),
                          } as Record<string, string>
                        )[key] ?? key}
                        : {String(change.from || '—')} → {String(change.to || '—')}
                      </p>
                    ))}
                </li>
              ))}
            </ol>
            {op && (
              <form
                className="space-y-3 border-t border-line pt-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  void update()
                }}
              >
                <Pick
                  label={l('Next status', '处理状态')}
                  value={nextStatus}
                  onChange={(v) => setNextStatus(v as Defect['status'])}
                  disabled={busy || dirty}
                  options={(['open', 'in_progress', 'closed'] as const).map((status) => ({
                    value: status,
                    label: statusLabel(status, l),
                  }))}
                />
                <Field
                  label={
                    nextStatus === 'closed' && record.status !== 'closed'
                      ? l('Closing statement', '关闭说明')
                      : record.status === 'closed' && nextStatus !== 'closed'
                        ? l('Reason for reopening', '重新打开原因')
                        : l('Treatment note', '处置说明')
                  }
                  value={note}
                  onChange={setNote}
                  multiline
                  required
                  disabled={busy || dirty}
                />
                {dirty && (
                  <p className="text-sm text-ink-3">
                    {l(
                      'Save the changed details before updating the status.',
                      '请先保存已修改的信息，再更新处理状态。',
                    )}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button variant="signal" type="submit" disabled={busy || dirty || !note.trim()}>
                    {l('Record update', '记录处理')}
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-crit">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

export function DefectLedger({ initialEvent }: { initialEvent?: DetectionEvent }) {
  const l = useAssetText(),
    op = useCan('operator'),
    data = useInspectionData()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState(''),
    [severity, setSeverity] = useState(''),
    [category, setCategory] = useState(''),
    [assetId, setAssetId] = useState(params.get('asset') ?? '')
  const [edit, setEdit] = useState<Defect | null | undefined>(initialEvent ? null : undefined),
    [error, setError] = useState('')
  useEffect(() => {
    setEdit(initialEvent ? null : undefined)
    setAssetId(params.get('asset') ?? '')
    setError('')
  }, [data.site, initialEvent])
  const shown = data.defects.filter(
    (d) =>
      (!status || d.status === status) &&
      (!severity || d.severity === severity) &&
      (!category || d.category === category) &&
      (!assetId || d.assetId === assetId) &&
      [d.title, d.description, d.submittedBy, d.assignedTo, d.category]
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase()),
  )
  const exportCsv = async () => {
    const q = new URLSearchParams()
    if (query) q.set('q', query)
    if (status) q.set('status', status)
    if (severity) q.set('severity', severity)
    if (category) q.set('category', category)
    if (assetId) q.set('assetId', assetId)
    try {
      await downloadInspectionCsv(data.site, `/defects/export?${q}`, 'defects.csv')
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-3">
          {l(
            'Track equipment defects from submission to a recorded resolution.',
            '跟踪缺陷提交、责任人、处置记录与关闭说明。',
          )}
        </p>
        {op && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void exportCsv()}>
              <Download size={14} />
              CSV
            </Button>
            <Button variant="signal" onClick={() => setEdit(null)}>
              <Plus size={14} />
              {l('Report defect', '提交缺陷')}
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <Input
            aria-label={l('Search defects', '搜索缺陷')}
            placeholder={l('Search title or person', '搜索名称或人员')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Pick
          label={l('Status', '处理状态')}
          value={status}
          onChange={setStatus}
          empty={l('All statuses', '全部状态')}
          options={['open', 'in_progress', 'closed'].map((v) => ({ value: v, label: statusLabel(v, l) }))}
        />
        <Pick
          label={l('Severity', '缺陷等级')}
          value={severity}
          onChange={setSeverity}
          empty={l('All severities', '全部等级')}
          options={[
            { value: 'minor', label: l('Minor', '轻微') },
            { value: 'major', label: l('Major', '严重') },
          ]}
        />
        <Pick
          label={l('Category', '分类')}
          value={category}
          onChange={setCategory}
          empty={l('All categories', '全部分类')}
          options={[...new Set(data.defects.map((d) => d.category))].sort().map((v) => ({ value: v, label: v }))}
        />
        <Pick
          label={l('Equipment', '设备')}
          value={assetId}
          onChange={setAssetId}
          empty={l('All equipment', '全部设备')}
          options={data.assets.map((a) => ({ value: a.id, label: a.name }))}
        />
      </div>
      {(data.error || error) && (
        <div role="alert" className="flex items-center gap-3 border border-crit p-3 text-sm text-crit">
          {data.error || error}
          <Button variant="outline" onClick={data.refresh}>
            {l('Retry', '重试')}
          </Button>
        </div>
      )}
      <Panel className="overflow-x-auto">
        <Table className="min-w-[880px]">
          <TableHeader>
            <TableRow>
              {[
                l('Defect / equipment', '缺陷 / 设备'),
                l('Severity', '等级'),
                l('Category', '分类'),
                l('Status', '状态'),
                l('Submitted by', '提交人'),
                l('Responsible operator', '处理人'),
                l('Updated', '更新时间'),
                '',
              ].map((s, i) => (
                <TableHead key={i}>{s}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <div>{d.title}</div>
                  <div className="text-xs text-ink-3">{data.assets.find((a) => a.id === d.assetId)?.name ?? '—'}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={d.severity === 'major' ? 'text-crit' : ''}>
                    {d.severity === 'major' ? l('Major', '严重') : l('Minor', '轻微')}
                  </Badge>
                </TableCell>
                <TableCell>{d.category}</TableCell>
                <TableCell>
                  <Badge variant="outline">{statusLabel(d.status, l)}</Badge>
                </TableCell>
                <TableCell>{d.submittedBy}</TableCell>
                <TableCell>{d.assignedTo || l('Unassigned', '未指派')}</TableCell>
                <TableCell className="mono text-xs">{new Date(d.updatedAt).toLocaleString()}</TableCell>
                <TableCell>
                  <Button variant="ghost" onClick={() => setEdit(d)}>
                    {l('Open', '查看')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!shown.length && (
          <EmptyNote>
            {data.loading
              ? l('Loading defect records…', '正在加载缺陷记录…')
              : data.defects.length
                ? l('No defects match these filters.', '没有符合筛选条件的缺陷。')
                : l('No defects have been reported at this site.', '该场站尚无缺陷记录。')}
          </EmptyNote>
        )}
      </Panel>
      {edit !== undefined && (
        <DefectEditor
          key={`${data.site}:${edit?.id ?? 'new'}`}
          defect={edit}
          event={!edit ? initialEvent : undefined}
          assets={data.assets}
          tags={data.tags}
          assignees={data.assignees}
          onClose={() => {
            setEdit(undefined)
            if (params.has('fromEvent')) {
              const next = new URLSearchParams(params)
              next.delete('fromEvent')
              setParams(next, { replace: true })
            }
          }}
          onSaved={data.refresh}
        />
      )}
    </div>
  )
}
