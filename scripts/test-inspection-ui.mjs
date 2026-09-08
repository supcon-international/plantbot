#!/usr/bin/env node
// Run after WEB_BASE=/robots/ pnpm build. Uses an isolated database, the actual
// production bundle and a subpath reverse proxy. No production services touched.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'web/dist'),
  out = join(root, 'demos/inspection-qa')
assert.ok(existsSync(join(dist, 'index.html')), 'Build the production bundle first')
const data = mkdtempSync(join(tmpdir(), 'pb-ui-'))
mkdirSync(out, { recursive: true })
const apiPort = 8992,
  webPort = 5186,
  base = `http://127.0.0.1:${webPort}/robots`
const proc = spawn(join(root, 'server/node_modules/.bin/tsx'), ['server/src/index.ts'], {
  cwd: root,
  env: {
    ...process.env,
    API_PORT: String(apiPort),
    API_HOST: '127.0.0.1',
    PB_DATA_DIR: data,
    PB_DEMO: '1',
    PB_DEV_KEYS: '1',
    PUBLIC_BASE: '/robots',
    SESSION_SECRET: 'isolated-ui-test',
    PB_RECORDING_SEGMENT_SEC: '2',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
proc.stdout.on('data', (b) => {
  serverLog += b
})
proc.stderr.on('data', (b) => {
  serverLog += b
})
const wait = async (fn, label, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const result = await fn().catch(() => false)
    if (result) return result
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Timed out: ${label}`)
}
const proxy = createServer((req, res) => {
  if (!req.url.startsWith('/robots')) {
    res.writeHead(404)
    res.end()
    return
  }
  const url = req.url.slice(7) || '/'
  if (/^\/(api|media)\//.test(url)) {
    const upstream = request(
      { hostname: '127.0.0.1', port: apiPort, path: url, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode, r.headers)
        r.pipe(res)
      },
    )
    upstream.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
    return
  }
  const file = resolve(dist, `.${decodeURIComponent(url.split('?')[0])}`)
  const target =
    file.startsWith(`${dist}/`) && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html')
  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  }
  res.setHeader('content-type', mime[extname(target)] ?? 'application/octet-stream')
  res.end(readFileSync(target))
})
proxy.on('upgrade', (req, socket, head) => {
  const upstream = connect(apiPort, '127.0.0.1', () => {
    upstream.write(
      `${req.method} ${req.url.slice(7)} HTTP/1.1\r\n${Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')}\r\n\r\n`,
    )
    if (head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
})
let browser, adapterTimer, page
const checks = [],
  errors = [],
  badResponses = []
try {
  await wait(async () => (await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok, 'API ready')
  await new Promise((r) => proxy.listen(webPort, '127.0.0.1', r))
  const north = async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/integration/v1${path}`, {
      method,
      headers: { authorization: 'Bearer pbk_dev_plant07', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    assert.ok(r.ok, `fixture ${path}: ${r.status}`)
    return r.json()
  }
  await north('POST', '/robots', {
    serial: 'UI-PTZ',
    model: 'Inspection camera fixture',
    callsign: 'QA Camera',
    level: 'dispatchable',
    streams: [
      {
        id: 'ptz',
        name: 'QA PTZ camera',
        kind: 'camera',
        url: '/robots/media/perimeter.mp4',
        ptz: { absolute: true, pan: [-180, 180], tilt: [-90, 90], zoom: [1, 20] },
      },
    ],
  })
  let pumping = false
  adapterTimer = setInterval(async () => {
    if (pumping) return
    pumping = true
    try {
      await north('POST', '/robots/UI-PTZ/state', { x: 1, z: 1, battery: 90, mode: 'idle' })
      const { orders } = await north('GET', '/robots/UI-PTZ/orders')
      for (const o of orders)
        await north('POST', `/orders/${o.id}/status`, {
          status: 'done',
          note: 'UI test adapter confirmed the requested pose',
        })
    } catch {
    } finally {
      pumping = false
    }
  }, 400)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('response', (r) => {
    if (r.status() >= 400 && /\/robots\/(api|assets)\//.test(r.url())) badResponses.push(`${r.status()} ${r.url()}`)
  })
  const screenshot = async (name) => page.screenshot({ path: join(out, `${name}.png`), fullPage: true })
  const pick = async (label, option) => {
    const scope = (await page.getByRole('dialog').count()) ? page.getByRole('dialog') : page
    await scope.getByLabel(label, { exact: false }).click()
    await page.getByRole('option', { name: option, exact: false }).click()
  }
  const bodyHas = async (text) =>
    wait(async () => (await page.locator('body').innerText()).toLowerCase().includes(text.toLowerCase()), text)
  await page.goto(`${base}/login`)
  await page.locator('#login-user').fill('admin')
  await page.locator('#login-pass').fill('plantbot')
  await page.locator('form button[type="submit"]').click()
  await page.waitForURL((url) => url.pathname === '/robots' || url.pathname === '/robots/')
  checks.push('Real login and hydration at /robots/')

  await page.getByRole('link', { name: 'Assets', exact: true }).first().click()
  await page.getByRole('button', { name: 'Add asset', exact: true }).click()
  await page.getByLabel('Equipment name').fill('QA Transformer')
  await page.getByLabel('Equipment type').fill('Transformer')
  await page.getByLabel('Location', { exact: true }).fill('North substation')
  await page.getByLabel('Manufacturer').fill('QA Works')
  await page.getByRole('button', { name: 'Save asset', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await bodyHas('QA Transformer')
  await page.getByRole('radio', { name: /Tag register/ }).click()
  await page.getByRole('button', { name: 'Add tag', exact: true }).click()
  await page.getByLabel('Tag name').fill('TT-QA-101')
  await page.getByLabel('Inspection point').click()
  await page.getByRole('option').nth(1).click()
  await page.getByLabel('Address / source reference').fill('plant/transformer/temperature')
  await page.getByLabel('Unit', { exact: true }).fill('°C')
  await page.getByRole('button', { name: 'Save tag', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await bodyHas('TT-QA-101')
  const assetCsv = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV', exact: true }).click()
  assert.ok((await assetCsv).suggestedFilename().endsWith('.csv'))
  await screenshot('01-tags-en')
  checks.push('Equipment and structured tag creation, point binding and CSV download')

  await page.goto(`${base}/events?view=defects`)
  await page.getByRole('button', { name: 'Report defect', exact: true }).click()
  await page.getByLabel('Defect title').fill('QA cabinet temperature')
  await page.getByLabel('Description', { exact: true }).fill('Review the high temperature reading')
  await pick('Equipment', 'QA Transformer')
  await pick('Responsible operator', '(admin)')
  await page.getByRole('button', { name: 'Submit defect', exact: true }).click()
  await bodyHas('Treatment history')
  await pick('Next status', 'In progress')
  await page.getByLabel('Treatment note').fill('Technician inspected the cabinet')
  await page.getByRole('button', { name: 'Record update', exact: true }).click()
  await bodyHas('Technician inspected the cabinet')
  await pick('Next status', 'Closed')
  await page.getByLabel('Closing statement', { exact: false }).fill('Cooling fan repaired and temperature verified')
  await page.getByRole('button', { name: 'Record update', exact: true }).click()
  await bodyHas('Cooling fan repaired and temperature verified')
  await screenshot('02-defect-history-en')
  await page.keyboard.press('Escape')
  checks.push('Defect creation, assignment, in-progress treatment, closure and durable history')

  await page.getByRole('link', { name: 'Live', exact: true }).first().click()
  await page.getByRole('tab', { name: 'Recordings', exact: true }).click()
  await page.getByLabel('Recording channel').click()
  await page.getByRole('option').nth(1).click()
  await page.getByRole('switch', { name: 'Record this channel' }).click()
  await page.getByRole('button', { name: 'Play', exact: true }).first().waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: 'Play', exact: true }).first().click()
  await wait(
    async () => page.locator('video').evaluate((v) => v.readyState >= 2 && v.currentTime > 0),
    'actual video playback',
  )
  await page.locator('video').evaluate((v) => {
    v.currentTime = Math.min(1, v.duration / 2)
  })
  const videoDownload = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download MP4' }).click()
  assert.ok((await videoDownload).suggestedFilename().endsWith('.mp4'))
  await screenshot('03-recording-playback-en')
  await page.getByRole('switch', { name: 'Record this channel' }).click()
  checks.push('Recording enable/stop, segment search, decoded video playback, seek and MP4 download')

  // PTZ configuration and execution are exercised below using the explicitly
  // declared external adapter fixture; no physical device claim is made.
  await page.getByRole('tab', { name: 'PTZ inspection', exact: true }).click()
  await bodyHas('QA PTZ camera')
  for (const [name, pan] of [
    ['QA gauge', '20'],
    ['QA cabinet', '40'],
  ]) {
    await page.getByRole('button', { name: 'New preset', exact: true }).click()
    await page.getByLabel('Preset name').fill(name)
    await page.getByRole('spinbutton', { name: 'Pan', exact: true }).fill(pan)
    await page.getByRole('button', { name: 'Save preset', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
  }
  await page.getByRole('tab', { name: /Inspection plans/ }).click()
  await page.getByRole('button', { name: 'New plan', exact: true }).click()
  await page.getByLabel('Plan name').fill('QA camera route')
  await page.getByLabel('Stop 1 dwell seconds', { exact: true }).fill('1')
  await page.getByRole('button', { name: 'Add stop', exact: true }).click()
  await pick('Stop 2 preset', 'QA gauge')
  await page.getByLabel('Stop 2 dwell seconds', { exact: true }).fill('1')
  await page.getByRole('button', { name: 'Move stop up', exact: true }).nth(1).click()
  assert.equal(await page.getByRole('dialog').count(), 1, 'Reordering does not submit the plan')
  await page.getByRole('button', { name: 'Save plan', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Run now', exact: true }).click()
  await wait(async () => {
    const r = await context.request.get(`${base}/api/sites/plant-07/ptz`)
    const state = await r.json()
    return state.runs.find(
      (r) =>
        r.name === 'QA camera route' &&
        r.status === 'done' &&
        r.steps.length === 2 &&
        r.steps.every((s) => s.completedAt >= s.arrivedAt + 1000),
    )
  }, 'PTZ two-stop run completed after real adapter acknowledgements and dwell')
  await bodyHas('Completed')
  await page.getByRole('button', { name: 'View record', exact: true }).first().click()
  await bodyHas('UI test adapter confirmed the requested pose')
  await screenshot('04-ptz-en')
  await page.keyboard.press('Escape')
  checks.push(
    'PTZ preset creation, plan reordering without submit, two-stop execution with acknowledgement/dwell, record review',
  )

  await page.goto(`${base}/missions`)
  await page.getByRole('radio', { name: 'Calendar', exact: true }).click()
  await bodyHas('Mission calendar')
  await page.getByRole('radio', { name: 'Week', exact: true }).click()
  await page.getByRole('button', { name: 'Next period' }).click()
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await screenshot('05-calendar-en')
  await page.getByRole('radio', { name: 'Archive & reports', exact: true }).click()
  await bodyHas('Inspection archive')
  // Seeded recurring schedules may not have fired yet: create a run through
  // the normal API, then inspect/export the resulting persistent record in UI.
  const fleet = await (await context.request.get(`${base}/api/sites/plant-07/fleet`)).json()
  const created = await context.request.post(`${base}/api/sites/plant-07/missions`, {
    data: {
      name: 'QA archived inspection',
      requestedRobot: 'auto',
      priority: 2,
      steps: [{ waypointId: fleet.waypoints[0].id, actions: [{ type: 'capture_photo', durationS: 1 }] }],
    },
  })
  assert.ok(created.ok(), await created.text())
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('button', { name: /QA archived inspection/ }).click()
  const [reportPage] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: 'Print report', exact: true }).first().click(),
  ])
  await reportPage.waitForLoadState()
  assert.match(await reportPage.locator('body').innerText(), /QA archived inspection/)
  await reportPage.close()
  const reportCsv = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export CSV', exact: true }).first().click()
  await reportCsv
  checks.push('Calendar week navigation and persistent run archive with printable report and CSV')

  await page.goto(`${base}/sites`)
  await page.getByRole('button', { name: 'Add unit', exact: true }).click()
  await page.locator('#org-name').fill('QA Operations')
  await page.getByRole('button', { name: 'Save', exact: true }).last().click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await bodyHas('QA Operations')
  await page.getByRole('radio', { name: 'Audit logs', exact: true }).click()
  await bodyHas('POST /api/organization/units')
  await screenshot('06-audit-en')
  checks.push('Organization unit creation and server-recorded audit visibility')

  await page.goto(`${base}/live`)
  await page.getByRole('tab', { name: 'Recordings', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor()
  let releaseOld,
    reportHeld,
    oldFinished = false
  const oldGate = new Promise((r) => {
      releaseOld = r
    }),
    held = new Promise((r) => {
      reportHeld = r
    })
  let delayOne = true
  await page.route('**/api/sites/plant-07/recordings?**', async (route) => {
    if (!delayOne) return route.continue()
    delayOne = false
    reportHeld()
    await oldGate
    await route.continue().catch(() => {})
    oldFinished = true
  })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await held
  await page.locator('.site-switch [role="combobox"]').click()
  await page.getByRole('option', { name: /Plant 12/ }).click()
  releaseOld()
  await wait(async () => oldFinished, 'old-site request released')
  await bodyHas('No recordings in this time range')
  assert.equal(
    await page.getByRole('button', { name: 'Play', exact: true }).count(),
    0,
    'Old-site archive never replaces new site',
  )
  await page.unroute('**/api/sites/plant-07/recordings?**')
  await page.locator('.site-switch [role="combobox"]').click()
  await page.getByRole('option', { name: /Plant 07/ }).click()
  checks.push('Delayed manual archive refresh cannot overwrite another site after switching')

  await page.getByRole('radio', { name: '中文', exact: true }).click()
  await page.goto(`${base}/assets`)
  await bodyHas('设备与位号')
  await screenshot('07-assets-zh')
  await page.getByRole('button', { name: '切换明暗模式' }).click()
  await screenshot('08-assets-light-zh')
  await page.getByRole('button', { name: '切换明暗模式' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  for (const [path, expected] of [
    ['assets', '设备与位号'],
    ['events?view=defects', '缺陷'],
    ['live', '视频与云台'],
    ['missions', '日历'],
    ['sites', '组织管理'],
  ]) {
    await page.goto(`${base}/${path}`)
    await bodyHas(expected)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
    assert.equal(overflow, false, `Mobile page overflows: ${path}`)
  }
  await screenshot('09-mobile-zh')
  checks.push('Chinese translation and 390px mobile navigation/layout')
  await page.goto(`${base}/assets?embed=1&site=plant-07`)
  await bodyHas('设备与位号')
  await screenshot('10-embedded-zh')
  checks.push('Light/dark themes and embedded module navigation at the production subpath')

  const viewer = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const viewerPage = await viewer.newPage()
  await viewerPage.goto(`${base}/assets`)
  await viewerPage.getByRole('heading', { name: 'Equipment & tags' }).waitFor()
  assert.equal(await viewerPage.getByRole('button', { name: 'Add asset', exact: true }).count(), 0)
  await viewerPage.goto(`${base}/live`)
  await viewerPage.getByRole('tab', { name: 'Recordings', exact: true }).click()
  assert.equal(await viewerPage.getByRole('switch', { name: 'Record this channel' }).count(), 0)
  await viewer.close()
  checks.push('Anonymous viewer cannot reach create or recording-control actions')
  assert.deepEqual(errors, [], 'No browser runtime/console errors')
  assert.deepEqual(badResponses, [], 'No failed API or built-asset requests')
  writeFileSync(join(out, 'result.json'), JSON.stringify({ passed: true, checks, errors, badResponses }, null, 2))
  console.log(JSON.stringify({ passed: true, checks, screenshots: out }, null, 2))
} catch (e) {
  await page?.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {})
  writeFileSync(
    join(out, 'result.json'),
    JSON.stringify({ passed: false, checks, error: String(e), errors, badResponses, serverLog }, null, 2),
  )
  console.error(e)
  process.exitCode = 1
} finally {
  clearInterval(adapterTimer)
  await browser?.close()
  proxy.closeAllConnections()
  await new Promise((r) => proxy.close(r))
  if (proc.exitCode === null) {
    const closed = once(proc, 'close')
    proc.kill('SIGTERM')
    await closed
  }
  rmSync(data, { recursive: true, force: true })
}
