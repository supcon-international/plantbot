import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Plus, Download, Pencil, LayoutGrid, Table2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyNote, Modal, Panel } from '../components/ui'
import { useConfirm } from '../components/ConfirmDialog'
import { InspectionField as Field, InspectionHeading, InspectionSelect as Pick } from '../components/InspectionFields'
import { useApp, useCan, useSite } from '../lib/store'
import {
  downloadInspectionCsv,
  inspectionRequest,
  useAssetText,
  useInspectionData,
  type InspectionAsset,
  type AssetTag,
} from '../lib/inspection-assets'

const blankAsset = {
  name: '',
  kind: '',
  location: '',
  waypointId: '',
  manufacturer: '',
  model: '',
  serial: '',
  notes: '',
}
const blankTag = {
  assetId: '',
  name: '',
  waypointId: '',
  dataType: 'number' as const,
  unit: '',
  address: '',
  source: 'manual' as const,
  robotId: '',
  metric: '',
}
type AssetInput = Omit<InspectionAsset, 'id' | 'createdAt' | 'updatedAt'>
type TagInput = Omit<AssetTag, 'id' | 'createdAt' | 'updatedAt'>

function AssetEditor({
  asset,
  assets,
  tags,
  defects,
  onClose,
  onSaved,
}: {
  asset: InspectionAsset | null
  assets: InspectionAsset[]
  tags: AssetTag[]
  defects: { assetId: string; status: string }[]
  onClose: () => void
  onSaved: () => void
}) {
  const l = useAssetText(),
    admin = useCan('admin'),
    site = useSite((s) => s.siteId),
    confirm = useConfirm()
  const waypoints = useApp((s) => s.waypoints)
  const [form, setForm] = useState<AssetInput>(
    asset
      ? (Object.fromEntries(Object.keys(blankAsset).map((k) => [k, asset[k as keyof InspectionAsset]])) as AssetInput)
      : blankAsset,
  )
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const set = (key: keyof AssetInput, value: string) => setForm((f) => ({ ...f, [key]: value }))
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await inspectionRequest(site, `/assets${asset ? '/' + asset.id : ''}`, asset ? 'PATCH' : 'POST', form)
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!asset || !(await confirm({ title: l('Delete asset?', '删除设备？'), message: asset.name, destructive: true })))
      return
    setBusy(true)
    setError('')
    try {
      await inspectionRequest(site, `/assets/${asset.id}`, 'DELETE')
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const linkedTags = tags.filter((t) => t.assetId === asset?.id),
    linkedDefects = defects.filter((d) => d.assetId === asset?.id)
  return (
    <Modal wide title={asset?.name ?? l('Add asset', '添加设备')} onClose={onClose}>
      <InspectionHeading onClose={onClose}>{asset?.name ?? l('Add asset', '添加设备')}</InspectionHeading>
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label={l('Equipment name', '设备名称')}
            value={form.name}
            onChange={(v) => set('name', v)}
            required
            disabled={!admin || busy}
          />
          <Field
            label={l('Equipment type', '设备类型')}
            value={form.kind}
            onChange={(v) => set('kind', v)}
            required
            disabled={!admin || busy}
            placeholder={l('Transformer, switchgear, pump…', '变压器、开关柜、泵…')}
          />
          <Field
            label={l('Location', '位置')}
            value={form.location}
            onChange={(v) => set('location', v)}
            disabled={!admin || busy}
          />
          <Pick
            label={l('Inspection point', '巡检点位')}
            value={form.waypointId}
            onChange={(v) => set('waypointId', v)}
            disabled={!admin || busy}
            empty={l('Not linked', '未关联')}
            options={waypoints.map((w) => ({ value: w.id, label: w.name }))}
          />
          <Field
            label={l('Manufacturer', '制造商')}
            value={form.manufacturer}
            onChange={(v) => set('manufacturer', v)}
            disabled={!admin || busy}
          />
          <Field
            label={l('Model', '型号')}
            value={form.model}
            onChange={(v) => set('model', v)}
            disabled={!admin || busy}
          />
          <Field
            label={l('Serial number', '序列号')}
            value={form.serial}
            onChange={(v) => set('serial', v)}
            disabled={!admin || busy}
          />
        </div>
        <Field
          label={l('Equipment record / maintenance notes', '设备资料与维护备注')}
          value={form.notes}
          onChange={(v) => set('notes', v)}
          multiline
          disabled={!admin || busy}
        />
        {asset && (
          <div className="space-y-2 border-t border-line pt-3 text-sm text-ink-2">
            <div>
              {linkedTags.length} {l('tags', '个位号')} · {linkedDefects.filter((d) => d.status !== 'closed').length}{' '}
              {l('open defects', '个待处理缺陷')}
            </div>
            {linkedTags.map((t) => (
              <div className="flex justify-between gap-3" key={t.id}>
                <span className="mono">{t.name}</span>
                <span>
                  {t.address} · {t.unit || t.dataType}
                </span>
              </div>
            ))}
            <Link to={`/events?view=defects&asset=${asset.id}`} onClick={onClose} className="text-link">
              {l('View equipment defects', '查看设备缺陷')}
            </Link>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-crit">
            {error}
          </p>
        )}
        {admin && (
          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            {asset ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void remove()}>
                <Trash2 size={14} />
                {l('Delete', '删除')}
              </Button>
            ) : (
              <span />
            )}
            <Button variant="signal" type="submit" disabled={busy || !form.name.trim() || !form.kind.trim()}>
              {busy ? l('Saving…', '保存中…') : l('Save asset', '保存设备')}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  )
}
function TagEditor({
  tag,
  assets,
  onClose,
  onSaved,
}: {
  tag: AssetTag | null
  assets: InspectionAsset[]
  onClose: () => void
  onSaved: () => void
}) {
  const l = useAssetText(),
    admin = useCan('admin'),
    site = useSite((s) => s.siteId),
    confirm = useConfirm()
  const waypoints = useApp((s) => s.waypoints),
    robots = useApp((s) => s.robots),
    metrics = useApp((s) => s.metricDefs),
    readings = useApp((s) => s.readings)
  const [form, setForm] = useState<TagInput>(
    tag
      ? (Object.fromEntries(Object.keys(blankTag).map((k) => [k, tag[k as keyof AssetTag]])) as TagInput)
      : { ...blankTag, assetId: assets[0]?.id ?? '' },
  )
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const set = (key: keyof TagInput, value: string) => setForm((f) => ({ ...f, [key]: value }))
  const live = form.robotId && form.metric ? readings[`${form.robotId}|${form.metric}`]?.at(-1) : null
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await inspectionRequest(site, `/asset-tags${tag ? '/' + tag.id : ''}`, tag ? 'PATCH' : 'POST', form)
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!tag || !(await confirm({ title: l('Delete tag?', '删除位号？'), message: tag.name, destructive: true })))
      return
    setBusy(true)
    setError('')
    try {
      await inspectionRequest(site, `/asset-tags/${tag.id}`, 'DELETE')
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal wide title={tag?.name ?? l('Add tag', '添加位号')} onClose={onClose}>
      <InspectionHeading onClose={onClose}>{tag?.name ?? l('Add tag', '添加位号')}</InspectionHeading>
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Pick
            label={l('Equipment', '设备')}
            value={form.assetId}
            onChange={(v) => {
              set('assetId', v)
              const wp = assets.find((a) => a.id === v)?.waypointId
              if (wp) set('waypointId', wp)
            }}
            required
            disabled={!admin || busy}
            empty={l('Select equipment', '选择设备')}
            options={assets.map((a) => ({ value: a.id, label: a.name }))}
          />
          <Field
            label={l('Tag name', '位号名称')}
            value={form.name}
            onChange={(v) => set('name', v)}
            required
            disabled={!admin || busy}
            placeholder="TT-101"
          />
          <Pick
            label={l('Inspection point', '巡检点位')}
            value={form.waypointId}
            onChange={(v) => set('waypointId', v)}
            required
            disabled={!admin || busy}
            empty={l('Select point', '选择点位')}
            options={waypoints.map((w) => ({ value: w.id, label: w.name }))}
          />
          <Field
            label={l('Address / source reference', '地址 / 来源引用')}
            value={form.address}
            onChange={(v) => set('address', v)}
            required
            disabled={!admin || busy}
            placeholder="plant/transformer-01/temperature"
          />
          <Pick
            label={l('Data type', '数据类型')}
            value={form.dataType}
            onChange={(v) => set('dataType', v)}
            disabled={!admin || busy || form.source !== 'manual'}
            options={[
              { value: 'number', label: l('Number', '数值') },
              { value: 'string', label: l('Text', '文本') },
              { value: 'boolean', label: l('Boolean', '布尔') },
            ]}
          />
          <Field
            label={l('Unit', '单位')}
            value={form.unit}
            onChange={(v) => set('unit', v)}
            disabled={!admin || busy || form.source !== 'manual'}
          />
        </div>
        <div className="space-y-3 border-t border-line pt-3">
          <h3 className="text-sm font-medium">{l('Data binding', '数据接入绑定')}</h3>
          <p className="text-sm text-ink-3">
            {l(
              'Bind a metric already reported by an adapter or integration. Device protocols and credentials stay in the connector.',
              '绑定 adapter 或集成已上报的指标。设备协议与凭证在连接器中管理。',
            )}
          </p>
          <Pick
            label={l('Source', '数据来源')}
            value={form.source}
            onChange={(v) => {
              set('source', v)
              if (v !== 'manual') set('dataType', 'number')
            }}
            disabled={!admin || busy}
            options={[
              { value: 'manual', label: l('Reference only', '仅台账引用') },
              { value: 'adapter', label: 'Robot adapter' },
              { value: 'integration', label: 'Integration API' },
            ]}
          />
          {form.source !== 'manual' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Pick
                label={l('Registered robot', '已接入机器人')}
                value={form.robotId}
                onChange={(v) => set('robotId', v)}
                required
                disabled={!admin || busy}
                empty={l('Select robot', '选择机器人')}
                options={robots.map((r) => ({ value: r.id, label: r.callsign }))}
              />
              <Pick
                label={l('Metric', '指标')}
                value={form.metric}
                onChange={(v) => {
                  set('metric', v)
                  set('unit', metrics.find((m) => m.id === v)?.unit ?? '')
                }}
                required
                disabled={!admin || busy}
                empty={l('Select metric', '选择指标')}
                options={metrics.map((m) => ({ value: m.id, label: `${m.label} · ${m.unit}` }))}
              />
            </div>
          )}
          {form.source !== 'manual' && (
            <p className="mono text-sm text-ink-2">
              {live
                ? `${live.value} ${form.unit} · ${new Date(live.ts).toLocaleString()}`
                : l('No reading received for this binding yet.', '该绑定暂未收到读数。')}
            </p>
          )}
          {admin && (
            <Link className="text-link text-sm" to="/integrations">
              {l('Manage connectors', '管理连接器')}
            </Link>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-crit">
            {error}
          </p>
        )}
        {admin && (
          <div className="flex justify-between gap-3 border-t border-line pt-3">
            {tag ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void remove()}>
                <Trash2 size={14} />
                {l('Delete', '删除')}
              </Button>
            ) : (
              <span />
            )}
            <Button
              variant="signal"
              type="submit"
              disabled={
                busy ||
                !form.assetId ||
                !form.name.trim() ||
                !form.waypointId ||
                !form.address.trim() ||
                (form.source !== 'manual' && (!form.robotId || !form.metric))
              }
            >
              {busy ? l('Saving…', '保存中…') : l('Save tag', '保存位号')}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  )
}

export default function Assets() {
  const l = useAssetText(),
    admin = useCan('admin'),
    canExport = useCan('operator')
  const { site, assets, tags, defects, error, loading, refresh } = useInspectionData()
  const waypoints = useApp((s) => s.waypoints)
  const [tab, setTab] = useState('assets'),
    [view, setView] = useState('cards'),
    [query, setQuery] = useState('')
  const [edit, setEdit] = useState<
    { kind: 'asset'; item: InspectionAsset | null } | { kind: 'tag'; item: AssetTag | null } | null
  >(null)
  const [exportError, setExportError] = useState('')
  useEffect(() => {
    setEdit(null)
    setQuery('')
    setExportError('')
  }, [site])
  const filteredAssets = assets.filter((a) =>
    [a.name, a.kind, a.location, a.serial, a.model].join(' ').toLowerCase().includes(query.toLowerCase()),
  )
  const filteredTags = tags.filter((t) =>
    [t.name, t.address, t.metric, assets.find((a) => a.id === t.assetId)?.name]
      .join(' ')
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const exportCsv = async () => {
    try {
      await downloadInspectionCsv(site, `/${tab === 'assets' ? 'assets' : 'asset-tags'}/export`, `${tab}.csv`)
      setExportError('')
    } catch (e) {
      setExportError((e as Error).message)
    }
  }
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-condensed text-3xl text-ink">{l('Equipment & tags', '设备与位号')}</h1>
          <p className="mt-1 text-sm text-ink-3">
            {l(
              'Equipment records, inspection points and the data collected at each point.',
              '管理被巡设备档案、巡检点位及每个点位的数据来源。',
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {canExport && (
            <Button variant="outline" onClick={() => void exportCsv()}>
              <Download size={14} />
              CSV
            </Button>
          )}
          {admin && (
            <Button
              variant="signal"
              disabled={tab === 'tags' && !assets.length}
              onClick={() => setEdit(tab === 'assets' ? { kind: 'asset', item: null } : { kind: 'tag', item: null })}
            >
              <Plus size={14} />
              {tab === 'assets' ? l('Add asset', '添加设备') : l('Add tag', '添加位号')}
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup type="single" value={tab} onValueChange={(v) => v && setTab(v)}>
          <ToggleGroupItem value="assets">
            {l('Equipment', '设备档案')} · {assets.length}
          </ToggleGroupItem>
          <ToggleGroupItem value="tags">
            {l('Tag register', '位号台账')} · {tags.length}
          </ToggleGroupItem>
        </ToggleGroup>
        <Input
          className="w-64"
          aria-label={l('Search equipment or tags', '搜索设备或位号')}
          placeholder={l('Search name, type or address', '搜索名称、类型或地址')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {tab === 'assets' && (
          <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v)} className="ml-auto">
            <ToggleGroupItem value="cards" aria-label={l('Equipment cards', '设备卡片')}>
              <LayoutGrid size={16} />
            </ToggleGroupItem>
            <ToggleGroupItem value="table" aria-label={l('Equipment table', '设备表格')}>
              <Table2 size={16} />
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      {(error || exportError) && (
        <div role="alert" className="flex items-center gap-3 border border-crit p-3 text-sm text-crit">
          {error || exportError}
          <Button variant="outline" onClick={refresh}>
            {l('Retry', '重试')}
          </Button>
        </div>
      )}
      {loading && !assets.length && !tags.length ? (
        <Panel>
          <EmptyNote>{l('Loading equipment records…', '正在加载设备档案…')}</EmptyNote>
        </Panel>
      ) : (
        <>
          {tab === 'assets' &&
            (filteredAssets.length ? (
              view === 'cards' ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {filteredAssets.map((a) => (
                    <Panel key={a.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <Badge variant="outline">{a.kind}</Badge>
                          <h2 className="mt-3 text-lg font-medium">{a.name}</h2>
                        </div>
                        <Button
                          variant="ghost"
                          size="iconSm"
                          aria-label={`${l('Open', '查看')} ${a.name}`}
                          onClick={() => setEdit({ kind: 'asset', item: a })}
                        >
                          <Pencil size={15} />
                        </Button>
                      </div>
                      <div className="mt-2 text-sm text-ink-3">
                        {a.location ||
                          waypoints.find((w) => w.id === a.waypointId)?.name ||
                          l('Location not recorded', '未记录位置')}
                      </div>
                      <p className="mono mt-2 text-xs text-ink-3">
                        {[a.manufacturer, a.model, a.serial].filter(Boolean).join(' · ') || '—'}
                      </p>
                      <div className="mt-4 flex justify-between border-t border-line pt-3 text-sm">
                        <span>
                          {tags.filter((t) => t.assetId === a.id).length} {l('tags', '个位号')}
                        </span>
                        <Link className="text-link" to={`/events?view=defects&asset=${a.id}`}>
                          {defects.filter((d) => d.assetId === a.id && d.status !== 'closed').length}{' '}
                          {l('open defects', '个待处理缺陷')}
                        </Link>
                      </div>
                    </Panel>
                  ))}
                </div>
              ) : (
                <Panel>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {[
                          l('Equipment', '设备'),
                          l('Type', '类型'),
                          l('Location', '位置'),
                          l('Model / serial', '型号 / 序列号'),
                          '',
                        ].map((s, i) => (
                          <TableHead key={i}>{s}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredAssets.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell>{a.name}</TableCell>
                          <TableCell>{a.kind}</TableCell>
                          <TableCell>{a.location || '—'}</TableCell>
                          <TableCell className="mono">
                            {a.model} {a.serial}
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" onClick={() => setEdit({ kind: 'asset', item: a })}>
                              {l('Open', '查看')}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Panel>
              )
            ) : (
              <Panel>
                <EmptyNote>
                  {query
                    ? l('No equipment matches this search.', '没有符合搜索的设备。')
                    : l(
                        'Add the equipment your robots inspect, then link inspection points and tags.',
                        '先添加机器人巡检的设备，再关联巡检点位和位号。',
                      )}
                </EmptyNote>
              </Panel>
            ))}
          {tab === 'tags' && (
            <Panel className="overflow-x-auto">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow>
                    {[
                      l('Equipment / tag', '设备 / 位号'),
                      l('Inspection point', '巡检点位'),
                      l('Data type', '数据类型'),
                      l('Unit', '单位'),
                      l('Address', '地址'),
                      l('Data binding', '数据绑定'),
                      '',
                    ].map((s, i) => (
                      <TableHead key={i}>{s}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTags.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        <div>{assets.find((a) => a.id === t.assetId)?.name ?? t.assetId}</div>
                        <div className="mono text-xs text-ink-3">{t.name}</div>
                      </TableCell>
                      <TableCell>{waypoints.find((w) => w.id === t.waypointId)?.name ?? t.waypointId}</TableCell>
                      <TableCell>{t.dataType}</TableCell>
                      <TableCell className="mono">{t.unit || '—'}</TableCell>
                      <TableCell className="mono max-w-60 truncate" title={t.address}>
                        {t.address}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{t.source === 'manual' ? l('Reference', '台账引用') : t.source}</Badge>
                        {t.metric && <div className="mono mt-1 text-xs">{t.metric}</div>}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" onClick={() => setEdit({ kind: 'tag', item: t })}>
                          {l('Open', '查看')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!filteredTags.length && (
                <EmptyNote>
                  {query
                    ? l('No tags match this search.', '没有符合搜索的位号。')
                    : l(
                        'Add a tag to connect equipment, inspection point, unit and data address.',
                        '添加位号，将设备、巡检点位、单位和数据地址对应起来。',
                      )}
                </EmptyNote>
              )}
            </Panel>
          )}
        </>
      )}
      {edit?.kind === 'asset' && (
        <AssetEditor
          key={`${site}:${edit.item?.id ?? 'new'}`}
          asset={edit.item}
          assets={assets}
          tags={tags}
          defects={defects}
          onClose={() => setEdit(null)}
          onSaved={refresh}
        />
      )}
      {edit?.kind === 'tag' && (
        <TagEditor
          key={`${site}:${edit.item?.id ?? 'new'}`}
          tag={edit.item}
          assets={assets}
          onClose={() => setEdit(null)}
          onSaved={refresh}
        />
      )}
    </div>
  )
}
