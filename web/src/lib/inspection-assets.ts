import { useCallback, useEffect, useState } from 'react'
import { apiFetch, useSite } from './store'
import { useLang } from './i18n'

export interface InspectionAsset {
  id: string
  name: string
  kind: string
  location: string
  waypointId: string
  manufacturer: string
  model: string
  serial: string
  notes: string
  createdAt: number
  updatedAt: number
}
export interface AssetTag {
  id: string
  assetId: string
  name: string
  waypointId: string
  dataType: 'number' | 'string' | 'boolean'
  unit: string
  address: string
  source: 'manual' | 'adapter' | 'integration'
  robotId: string
  metric: string
  createdAt: number
  updatedAt: number
}
export interface Defect {
  id: string
  title: string
  description: string
  assetId: string
  tagId: string
  eventId: string
  severity: 'minor' | 'major'
  category: string
  status: 'open' | 'in_progress' | 'closed'
  submittedBy: string
  assignedTo: string
  resolution: string
  createdAt: number
  updatedAt: number
  history: {
    at: number
    by: string
    action: string
    note: string
    from?: string
    to?: string
    changes?: Record<string, { from: unknown; to: unknown }>
  }[]
}
export interface Assignee {
  username: string
  displayName: string
}
export function useAssetText() {
  const lang = useLang((s) => s.lang)
  return useCallback((en: string, zh: string) => (lang === 'zh' ? zh : en), [lang])
}
export async function inspectionRequest<T>(
  site: string,
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await apiFetch(`/api/sites/${encodeURIComponent(site)}${path}`, {
    method,
    signal,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`)
  return result as T
}
export async function downloadInspectionCsv(site: string, path: string, filename: string) {
  const response = await apiFetch(`/api/sites/${encodeURIComponent(site)}${path}`)
  if (!response.ok) throw new Error((await response.json()).error ?? 'Export failed')
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function useInspectionData() {
  const site = useSite((s) => s.siteId)
  const [state, setState] = useState<{
    site: string
    assets: InspectionAsset[]
    tags: AssetTag[]
    defects: Defect[]
    assignees: Assignee[]
  }>({ site: '', assets: [], tags: [], defects: [], assignees: [] })
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((n) => n + 1), [])
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true)
    setError('')
    Promise.all([
      inspectionRequest<{ items: InspectionAsset[] }>(site, '/assets', 'GET', undefined, abort.signal),
      inspectionRequest<{ items: AssetTag[] }>(site, '/asset-tags', 'GET', undefined, abort.signal),
      inspectionRequest<{ items: Defect[] }>(site, '/defects', 'GET', undefined, abort.signal),
      inspectionRequest<{ items: Assignee[] }>(site, '/defect-assignees', 'GET', undefined, abort.signal),
    ])
      .then(([assets, tags, defects, assignees]) => {
        if (!abort.signal.aborted)
          setState({ site, assets: assets.items, tags: tags.items, defects: defects.items, assignees: assignees.items })
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message)
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false)
      })
    return () => abort.abort()
  }, [site, revision])
  return {
    ...(state.site === site ? state : { site, assets: [], tags: [], defects: [], assignees: [] }),
    error,
    loading,
    refresh,
  }
}
