import { apiFetch } from './store'
import type { DetectionEvent, DetectionRule, MetricDef, Severity } from './types'

export type Point = [number, number]
export interface VisionConfig {
  id?: string
  revision?: number
  name: string
  preset: string
  adapterId: string
  sourceId: string
  enabled: boolean
  region: Point[]
  line: Point[]
  direction: string
  threshold: number
  durationS: number
  confidence: number
  intervalS: number
  severity: string
  schedule: { days: number[]; start: string; end: string } | null
  assetId: string
  numeric: boolean
  unit: string
  min: number | null
  max: number | null
}
export interface VisionPreset {
  id: string
  en: string
  zh: string
  engine: string
  rule: string
}
export interface VisionAdapter {
  id: string
  name: string
  online: boolean
  sources: {
    id: string
    label: string
    view: string
    status: string
    note: string
    channelId?: string
  }[]
  models: { detector: string; ocr: string }
  capabilities?: { presets: string[] }
}
export interface VisionResult {
  id: string
  config: VisionConfig
  adapterId: string
  sourceId?: string
  channelId?: string
  capturedAt: number
  receivedAt?: number
  status: string
  value: number | null
  text: string
  note: string
  evidence: string
  model: string
  confidence?: number | null
  late: boolean
  jobId?: string
  eventId?: string
  evidenceExpired?: boolean
  annotations: { label: string; box: number[]; score: number | null }[]
}
export interface VisionData {
  presets: VisionPreset[]
  configs: VisionConfig[]
  adapters: VisionAdapter[]
  results: VisionResult[]
  jobs: { id: string; status: string; resultId?: string }[]
}
export interface MonitoringRule {
  id: string
  type: 'vision' | 'threshold' | 'sim' | 'external'
  name: string
  enabled: boolean
  severity: Severity
  sourceName: string
  channelId?: string
  runtime: {
    status: 'disabled' | 'offline' | 'unavailable' | 'idle' | 'active' | 'unknown'
    message: string
    lastObservedAt?: number
  }
  legacy?: boolean
  config: VisionConfig | DetectionRule
}
export interface MonitoringData {
  rules: MonitoringRule[]
  metrics: (MetricDef & { eventType?: string })[]
  presets: VisionPreset[]
}
export async function monitoringRequest<T>(
  site: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await apiFetch(`/api/sites/${encodeURIComponent(site)}${path}`, {
    method,
    ...(body !== undefined
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  })
  const json = await response.json()
  if (!response.ok) throw new Error(json.message || json.error || `HTTP ${response.status}`)
  return json as T
}
export const eventConfidence = (event: DetectionEvent): number | null => {
  if (event.trigger) return event.trigger.confidence
  // Older visual events used a synthetic 1; without the retained observation,
  // that value cannot establish the model's actual confidence.
  if (event.type.startsWith('vision-')) return null
  return event.confidence
}

export const confidenceText = (value: number | null | undefined, zh: boolean) =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : zh
      ? '未知'
      : 'Unknown'
