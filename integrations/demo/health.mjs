#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const c = JSON.parse(readFileSync(process.env.PB_ADAPTER_CONFIG ?? '/config/adapter.json'))
const response = await fetch(c.serverUrl.replace(/\/$/, '')+'/api/integration/v1/fleet', { headers: { authorization: `Bearer ${c.siteKey}` }, signal: AbortSignal.timeout(4000) })
if (!response.ok) throw new Error(`Fleet HTTP ${response.status}`)
const fleet = await response.json()
for (const id of ['ext-demo-spot', 'ext-demo-x30', 'ext-demo-f2']) {
  if (!fleet.robots.some(r => r.id === id) || !fleet.telemetry.some(t => t.id === id && t.mode !== 'offline')) throw new Error(`${id} has no live native adapter telemetry`)
}
