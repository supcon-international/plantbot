#!/usr/bin/env node
// Demo-only client of the existing admin API. No database access or fabricated results.
import { readFileSync, writeFileSync, existsSync, chmodSync, chownSync } from 'node:fs'
import { join } from 'node:path'
const pack = JSON.parse(readFileSync(new URL('./pack.json', import.meta.url)))
const stateDir = process.env.PB_DEMO_STATE ?? '/config'
const statePath = join(stateDir, 'installation.json')
const base = (process.env.PB_DEMO_SERVER_URL ?? 'http://api:8787').replace(/\/$/, '')
const rtsp = (process.env.PB_DEMO_RTSP_BASE ?? 'rtsp://demo-adapter:8554').replace(/\/$/, '')
const site = pack.siteId
let cookie = ''
const pause = (ms) => new Promise(r => setTimeout(r, ms))
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}/api${path}`, { method, signal: AbortSignal.timeout(15000),
    headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(result)}`)
  return result
}
function save(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2)+'\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  if (process.getuid?.() === 0) chownSync(path, 1000, 1000)
}
const auth = await fetch(`${base}/api/auth/login`, { method: 'POST', signal: AbortSignal.timeout(15000),
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.PB_DEMO_ADMIN_USER ?? 'admin', password: process.env.PB_ADMIN_PASSWORD }) })
if (!auth.ok) throw new Error(`Demo bootstrap requires a working platform admin login: HTTP ${auth.status}`)
cookie = auth.headers.get('set-cookie')?.split(';')[0] ?? ''
const saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : null
if (saved && (saved.packId !== pack.id || saved.serverUrl !== base)) throw new Error('Demo state belongs to another pack or Server; use a separate Compose project')
if (saved && saved.mediaRevision !== pack.mediaRevision) throw new Error(`Demo media revision ${saved.mediaRevision ?? 'legacy synthetic'} is incompatible with ${pack.mediaRevision}; existing rules and history were preserved. Back up the old installation, then use a new PB_DEMO_PROJECT and PB_DEMO_ENV_FILE for the recorded-camera demo.`)
const sites = (await api('/sites')).sites
const existing = sites.find(x => x.id === site)
if (existing && (!saved || existing.operator !== pack.operator)) throw new Error(`Refusing to adopt or overwrite existing site ${site}; choose a clean Server or remove only an obsolete demo installation explicitly`)
const state = saved ?? { packId: pack.id, mediaRevision: pack.mediaRevision, serverUrl: base, siteId: site, createdAt: Date.now() }
if (!existing) {
  if (saved) throw new Error('Demo site was removed; do not silently recreate it with stale keys')
  await api('/sites', 'POST', { id: site, name: pack.siteName, operator: pack.operator, bounds: { x: [-24,24], z: [-14,14] } })
  save(statePath, state)
}
const S = `/sites/${site}`
if (!state.key) {
  state.key = (await api(`${S}/api-keys`, 'POST', { label: pack.id })).apiKey.key
  save(statePath, state)
}
if (process.argv.includes('--rules')) {
  let data
  const deadline = Date.now()+120000
  do {
    data = await api(`${S}/vision`)
    if (data.adapters.some(a => a.id === pack.adapterId && a.online && a.sources.length === 2)) break
    if (Date.now() > deadline) throw new Error('Real vision process did not register its two sources; no fake results will be seeded')
    await pause(1000)
  } while (true)
  if (!state.rules) state.rules = {}
  for (const rule of pack.rules) {
    if (state.rules[rule.preset]) {
      if (!data.configs.some(c => c.id === state.rules[rule.preset])) throw new Error(`Demo ${rule.preset} rule was removed; refusing to overwrite user intent`)
      continue
    }
    const config = await api(`${S}/vision/configs`, 'POST', { ...rule, adapterId: pack.adapterId,
      assetId: rule.preset === 'ocr' ? state.assetId : '', enabled: true, confidence: .5, intervalS: 2 })
    state.rules[rule.preset] = config.id
    save(statePath, state)
  }
  console.log('[demo] Three real monitoring rules ready; recorded IR loop is 13.28 seconds and recorded area loop is 30 seconds. No historical observations/events were fabricated.')
} else {
  if (!state.geometry) {
    await api(`${S}/geometry`, 'PUT', { dockWp: 'DEMO-DOCK',
      waypoints: [
        { id: 'DEMO-DOCK', name: 'Demo · Charge dock', x: -11, z: -6, kind: 'dock' },
        { id: 'DEMO-WP-1', name: 'Demo · Thermal display station', x: -4, z: -2, kind: 'inspect' },
        { id: 'DEMO-WP-2', name: 'Demo · Restricted area', x: 4, z: 3, kind: 'inspect' },
        { id: 'DEMO-WP-3', name: 'Demo · Return lane', x: 8, z: -4, kind: 'nav' }],
      zones: [{ id: 'DEMO-ZONE', name: 'Demo · Restricted area', kind: 'restricted', polygon: [[1,0],[7,0],[7,6],[1,6]] }],
      cameras: [
        { id: 'demo-display', name: 'Demo · Recorded IR display', x: -4, z: -2, heading: 0, stream: 'demo-display', rtsp: `${rtsp}/instrument` },
        { id: 'demo-area', name: 'Demo · Recorded stairwell camera', x: 4, z: 3, heading: 0, stream: 'demo-area', rtsp: `${rtsp}/restricted-area` }]
    })
    state.geometry = true; save(statePath, state)
  }
  if (!state.assetId) {
    state.assetId = (await api(`${S}/assets`, 'POST', { name: 'Demo · Thermal camera display', kind: 'IR display reading', location: 'Recorded coal conveyor inspection', waypointId: 'DEMO-WP-1', notes: 'OCR reads the original thermal camera maximum-temperature display (31.1–34.3℃). The scene hotspot includes a person; this is not an equipment-overheat diagnosis or temperature inferred from image colours. 33℃ is a demonstration threshold.' })).id
    save(statePath, state)
  }
  if (!state.templateId) {
    state.templateId = (await api(`${S}/mission-templates`, 'POST', { name: 'Demo · Two-stop inspection route', steps: [
      { waypointId: 'DEMO-WP-1', actions: [{ type: 'capture_photo', durationS: 3 }] },
      { waypointId: 'DEMO-WP-2', actions: [{ type: 'capture_photo', durationS: 3 }] }]
    })).template.id
    save(statePath, state)
  }
  const stream = { id: 'front', name: 'Demo · Recorded camera', kind: 'camera', url: `${rtsp}/restricted-area` }
  save(join(stateDir, 'adapter.json'), { id: pack.adapterId, name: 'Demo · Real Adapter / recorded camera sources', serverUrl: base, siteKey: state.key,
    devices: [
      { vendor: 'spot', config: { serial: 'DEMO-SPOT', callsign: 'Demo · Spot', host: '127.0.0.1', port: 9103, user: 'admin', pass: 'spotdev2026', dockX: -11, dockZ: -6, streams: [stream] } },
      { vendor: 'deeprobotics', config: { serial: 'DEMO-X30', callsign: 'Demo · X30', host: '127.0.0.1', port: 30000, dockX: -11, dockZ: -6, streams: [stream] } },
      { vendor: 'gosuncn', config: { serial: 'DEMO-F2', callsign: 'Demo · F2', base: 'http://127.0.0.1:9101', user: 'campus01', pass: 'gorobot@2025', sn: 'F2230204117', streams: [stream] } }],
    sources: [
      { id: 'demo-display', label: 'Demo · Recorded IR display', channelId: 'cam:demo-display', view: 'fixed', url: '/opt/plantbot-demo/media/instrument.mp4', loop: true },
      { id: 'demo-area', label: 'Demo · Recorded stairwell camera', channelId: 'cam:demo-area', view: 'fixed', url: '/opt/plantbot-demo/media/restricted-area.mp4', loop: true }]
  })
  console.log('[demo] Site, two fixed cameras, equipment, route and private Adapter configuration ready')
}
