import { METRIC_DEFS } from './fleet.js'
import type { DetectionRule, World } from './world.js'

function fail(message: string): never { throw Object.assign(new Error(message), { statusCode: 400 }) }
const text = (v: unknown, name: string) => typeof v === 'string' && v.trim() && v.length <= 120 ? v.trim() : fail(`${name} required (up to 120 characters)`)
const finite = (v: unknown, name: string) => typeof v === 'number' && Number.isFinite(v) ? v : fail(`${name} must be finite`)
export const thresholdEventType = (metric: string) => `threshold-${metric.replaceAll('.', '-')}`
export const monitoringMetrics = METRIC_DEFS.map((m) => ({ ...m, eventType: thresholdEventType(m.id) }))

/** Existing rule storage remains the only threshold configuration source. */
export function validateRuleCreate(w: World, raw: unknown) {
  const b = raw as Record<string, any>
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail('object required')
  const name = text(b.name, 'name')
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') fail('enabled must be boolean')
  const severity = b.severity ?? 'high'
  if (!['info', 'low', 'high', 'critical'].includes(severity)) fail('invalid severity')
  if (b.kind === 'threshold') {
    const metric = METRIC_DEFS.find((m) => m.id === b.metric) ?? fail('unknown metric')
    const robot = w.robots.find((r) => r.id === b.robotId) ?? fail('registered robotId required')
    if (!['>', '<'].includes(b.op)) fail('op must be > or <')
    return { name, kind: 'threshold' as const, model: thresholdEventType(metric.id),
      source: robot.id, sourceName: robot.callsign, zone: 'Site-wide', robotId: robot.id,
      metric: metric.id, op: b.op as '>' | '<', bound: finite(b.bound, 'bound'),
      severity, enabled: b.enabled ?? true, threshold: 0 }
  }
  if (b.kind !== 'sim' || process.env.PB_DEMO !== '1')
    fail('use vision/configs for visual monitoring; rules require kind threshold (sim only in explicit demo mode)')
  const model = text(b.model, 'model')
  if (!w.eventTypes.some((t) => t.id === model)) fail('unknown event type')
  const threshold = b.threshold === undefined ? 0.6 : finite(b.threshold, 'threshold')
  if (threshold < 0 || threshold > 1) fail('threshold must be 0..1')
  return { name, kind: 'sim' as const, model, source: text(b.source, 'source'),
    sourceName: typeof b.sourceName === 'string' ? text(b.sourceName, 'sourceName') : undefined,
    zone: typeof b.zone === 'string' ? text(b.zone, 'zone') : undefined,
    robotId: typeof b.robotId === 'string' ? b.robotId : undefined,
    severity, enabled: b.enabled ?? true, threshold }
}

export function validateRulePatch(rule: DetectionRule, raw: unknown) {
  const b = raw as Record<string, any>
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail('object required')
  const allowed = ['name', 'enabled', 'severity', 'threshold', 'bound', 'op']
  if (Object.keys(b).some((key) => !allowed.includes(key))) fail('only name, enabled, severity, threshold, bound and op may be patched')
  const out: Partial<Pick<DetectionRule, 'name' | 'enabled' | 'severity' | 'threshold' | 'bound' | 'op'>> = {}
  if ('name' in b) out.name = text(b.name, 'name')
  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean') fail('enabled must be boolean')
    if (b.enabled && rule.kind === 'sim' && process.env.PB_DEMO !== '1') fail('sim requires explicit demo mode')
    out.enabled = b.enabled
  }
  if ('severity' in b) {
    if (!['info', 'low', 'high', 'critical'].includes(b.severity)) fail('invalid severity')
    out.severity = b.severity
  }
  if ('threshold' in b) {
    out.threshold = finite(b.threshold, 'threshold')
    if (out.threshold < 0 || out.threshold > 1) fail('threshold must be 0..1')
  }
  if ('bound' in b || 'op' in b) {
    if (rule.kind !== 'threshold') fail('bound and op require a threshold rule')
    if ('bound' in b) out.bound = finite(b.bound, 'bound')
    if ('op' in b) {
      if (!['>', '<'].includes(b.op)) fail('op must be > or <')
      out.op = b.op
    }
  }
  return out
}
