#!/usr/bin/env node
// WEB_BASE=/robots/ pnpm build && node scripts/test-tier0-ui.mjs
// TIER0_UI_BASELINE=1 records the pre-change design without accepting it as passing.
// Uses a temporary database and dynamically allocated ports. No robot is commanded.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createServer as createNetServer, connect } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'web/dist')
const baseline = process.env.TIER0_UI_BASELINE === '1'
const interactionsOnly = process.env.TIER0_UI_PHASE === 'interactions'
const out = join(root, 'demos/tier0-ui-qa', baseline ? 'baseline' : interactionsOnly ? 'interactions' : 'final')
assert.ok(existsSync(join(dist, 'index.html')), 'Build the production bundle first')
assert.match(readFileSync(join(dist, 'index.html'), 'utf8'), /\/robots\/assets\//, 'Build with WEB_BASE=/robots/')
const bundleHash = () => createHash('sha256').update(readFileSync(join(dist, 'index.html'))).digest('hex')
const evidence = { startedAt: new Date().toISOString(), bundleSha256: bundleHash(), scope: interactionsOnly ? 'interactions' : 'full' }
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'pb-tier0-ui-'))
const freePort = async () => {
  const s = createNetServer()
  await new Promise((done) => s.listen(0, '127.0.0.1', done))
  const port = s.address().port
  await new Promise((done) => s.close(done))
  return port
}
const apiPort = await freePort()
const proc = spawn(join(root, 'server/node_modules/.bin/tsx'), ['server/src/index.ts'], {
  cwd: root,
  env: { ...process.env, API_PORT: String(apiPort), API_HOST: '127.0.0.1', PB_DATA_DIR: data,
    PB_DEMO: '1', PB_DEV_KEYS: '1', PB_PUBLIC_VIEW: '1', PUBLIC_BASE: '/robots', SESSION_SECRET: 'isolated-tier0-ui-test' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
proc.stdout.on('data', (b) => { serverLog += b })
proc.stderr.on('data', (b) => { serverLog += b })
const wait = async (fn, label, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
const proxy = createServer((req, res) => {
  if (!/^\/robots(?:\/|\?|$)/.test(req.url)) { res.writeHead(404); res.end(); return }
  const url = req.url.slice(7) || '/'
  if (/^\/(api|media)\//.test(url)) {
    const upstream = request({ hostname: '127.0.0.1', port: apiPort, path: url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res)
    })
    upstream.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(upstream); return
  }
  const file = resolve(dist, `.${decodeURIComponent(url.split('?')[0])}`)
  const target = file.startsWith(`${dist}/`) && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html')
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
  res.setHeader('content-type', mime[extname(target)] ?? 'application/octet-stream')
  res.end(readFileSync(target))
})
const sockets = new Set()
proxy.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
proxy.on('upgrade', (req, socket, head) => {
  const upstream = connect(apiPort, '127.0.0.1', () => {
    upstream.write(`${req.method} ${req.url.slice(7)} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream); upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
})

let browser, page, fixtureTimer, base, context
const checks = [], views = [], errors = [], badResponses = [], expectedResponses = [], layoutIssues = [], accessibility = [], failedRequests = [], externalRequests = new Set()
const recordPage = (p) => {
  p.on('pageerror', (e) => errors.push({ url: p.url(), error: e.message }))
  p.on('console', (m) => {
    // Failed HTTP responses are separately classified with their exact URL.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource:')) errors.push({ url: p.url(), error: m.text() })
  })
  p.on('response', (r) => {
    if (r.status() < 400 || !r.url().startsWith(base)) return
    const value = `${r.status()} ${new URL(r.url()).pathname}`
    if (expectedResponses.includes(value)) return
    badResponses.push({ page: p.url(), response: value })
  })
  p.on('request', (r) => { if (/^https?:/.test(r.url()) && !r.url().startsWith(base)) externalRequests.add(r.url()) })
  p.on('requestfailed', (r) => {
    // Deliberately changing routes may abort lazy chunks/media; other failures are defects.
    if (!r.failure()?.errorText.includes('ERR_ABORTED')) failedRequests.push({ page: p.url(), url: r.url(), error: r.failure()?.errorText })
  })
  p.setDefaultTimeout(12000)
}
const screen = async (name, p = page) => {
  await p.screenshot({ path: join(out, `${name}.png`), fullPage: true, animations: 'disabled' })
}
const auditAccessibility = async (name, p = page) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const audit = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  accessibility.push({ name, violations: audit.violations.map(({ id, impact, description, helpUrl, nodes }) => ({
    id, impact, description, helpUrl,
    nodes: nodes.map(({ target, failureSummary, html }) => ({ target, failureSummary, html })),
  })) })
}
const inspect = async (name, p = page) => {
  const result = await p.evaluate(() => {
    const visible = (e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden'
    const name = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || (e.getAttribute('aria-labelledby') || '').split(' ').map((id) => document.getElementById(id)?.textContent || '').join(' ') || e.labels?.[0]?.textContent || e.innerText || '').trim()
    const main = document.querySelector('main')
    const controls = [...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=combobox]')].filter(visible)
    const describe = (e) => ({ tag: e.tagName, name: name(e), className: String(e.className).slice(0, 150), width: Math.round(e.getBoundingClientRect().width) })
    const clippedControls = controls.filter((e) => {
      const r = e.getBoundingClientRect()
      if (r.right <= innerWidth + 1 && r.left >= -1) return false
      for (let a = e.parentElement; a; a = a.parentElement) if (/auto|scroll/.test(getComputedStyle(a).overflowX) && a.scrollWidth > a.clientWidth + 1) return false
      return r.bottom > 0 && r.top < innerHeight
    }).map(describe)
    return {
      title: document.title, language: document.documentElement.lang, theme: document.documentElement.dataset.theme,
      mainText: main?.innerText.slice(0, 300), headings: [...document.querySelectorAll('h1')].filter(visible).map((e) => e.textContent),
      rootOverflow: document.documentElement.scrollWidth - innerWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
      unnamedControls: controls.filter((e) => !name(e)).map(describe), clippedControls,
      tinyControls: controls.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 24 || r.height < 24 }).map(describe),
    }
  })
  views.push({ name, url: p.url(), viewport: p.viewportSize(), ...result })
  await screen(name, p)
  if (!baseline) {
    if (!(result.mainText?.trim().length > 10)) layoutIssues.push({ name, issue: 'Missing meaningful route content' })
    if (result.rootOverflow > 1 || result.mainOverflow > 1) layoutIssues.push({ name, issue: 'Horizontal overflow', root: result.rootOverflow, main: result.mainOverflow })
    if (result.clippedControls.length) layoutIssues.push({ name, issue: 'Controls outside viewport', controls: result.clippedControls })
    if (result.unnamedControls.length) layoutIssues.push({ name, issue: 'Unnamed controls', controls: result.unnamedControls })
  }
  return result
}
const navigate = async (path, p = page) => {
  await p.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  await p.locator('main').waitFor()
  await wait(async () => (await p.locator('main').innerText()).trim().length > 10, `route ${path} rendered`)
  await p.evaluate(() => document.fonts.ready)
  if (path.split('?')[0] === '/') {
    const robotCard = p.getByRole('link', { name: /^QA Inspection 01/ }).first()
    await robotCard.waitFor()
    await wait(async () => (await robotCard.innerText()).includes('85%'), 'Overview has received the live fixture battery')
    await robotCard.getByText(/steady|稳定/i).waitFor()
  }
  if (['/', '/map'].includes(path.split('?')[0])) {
    const canvas = p.locator('main canvas').first()
    await canvas.waitFor({ state: 'visible', timeout: 30000 })
    await wait(async () => canvas.evaluate((c) => c.width > 300 && c.getBoundingClientRect().width > 300), `route ${path}: real map canvas`, 30000)
    await wait(async () => p.locator('main .skeleton:visible').count().then((n) => n === 0), `route ${path}: map loading completed`, 30000)
    // Give the WebGL scene a rendered frame after fonts and local geometry load.
    await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    if (!baseline) {
      await wait(async () => {
        const png = await canvas.screenshot()
        return p.evaluate(async (base64) => {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
          const probe = document.createElement('canvas'); probe.width = bitmap.width; probe.height = bitmap.height
          const ctx = probe.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0)
          const { data } = ctx.getImageData(0, 0, probe.width, probe.height)
          const colors = new Set()
          for (let i = 0; i < data.length; i += 64) colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`)
          bitmap.close()
          return colors.size > 12
        }, png.toString('base64'))
      }, `route ${path}: map has rendered geometry, not a blank WebGL canvas`, 30000)
    }
  }
  await p.waitForTimeout(180)
}
const routeList = [
  ['overview', '/'], ['live', '/live'], ['missions', '/missions'], ['fleet', '/robots'],
  ['robot', '/robots/ext-ui-design'], ['map', '/map'], ['events', '/events'],
  ['assets', '/assets'], ['integrations', '/integrations'], ['sites', '/sites'],
  ['builder', '/sites/plant-07'], ['docs', '/docs'],
]

try {
  await wait(async () => (await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok, 'isolated API ready')
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${proxy.address().port}/robots`
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  page = await context.newPage(); recordPage(page)
  await navigate('/login')
  await page.locator('#login-user').fill('admin')
  await page.locator('#login-pass').fill('plantbot')
  await page.locator('form button[type=submit]').click()
  await page.waitForURL((u) => ['/robots', '/robots/'].includes(u.pathname))
  await wait(async () => (await page.locator('main').innerText()).length > 30, 'authenticated hydration')
  checks.push('Real login and hydrated production bundle under /robots/')
  const api = async (method, path, body) => {
    const r = await context.request.fetch(`${base}/api${path}`, { method, ...(body ? { data: body } : {}) })
    assert.ok(r.ok(), `${method} ${path}: ${await r.text()}`)
    return r.json()
  }
  const north = async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/integration/v1${path}`, { method,
      headers: { authorization: 'Bearer pbk_dev_plant07', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    assert.ok(r.ok, `fixture ${path}: ${r.status}`); return r.json()
  }
  const schedules = await api('GET', '/sites/plant-07/schedules')
  for (const s of schedules.schedules) await api('PATCH', `/sites/plant-07/schedules/${s.id}`, { enabled: false })
  await north('POST', '/robots', { serial: 'UI-DESIGN', model: 'UI audit fixture', callsign: 'QA Inspection 01', level: 'state-only',
    streams: [{ id: 'camera', name: 'QA Front camera', kind: 'camera', url: '/robots/media/perimeter.mp4' }] })
  const state = () => north('POST', '/robots/UI-DESIGN/state', { x: 2, z: 2, battery: 85, mode: 'idle' })
  await state(); fixtureTimer = setInterval(() => state().catch(() => {}), 1500)
  const storage = await context.storageState()
  await context.close()

  const configs = baseline
    ? [{ lang: 'en', theme: 'dark', width: 1440 }, { lang: 'zh', theme: 'light', width: 375 }]
    : ['en', 'zh'].flatMap((lang) => ['light', 'dark'].flatMap((theme) => [375, 768, 1440].map((width) => ({ lang, theme, width }))))
  for (const config of interactionsOnly ? [] : configs) {
    context = await browser.newContext({ storageState: storage, viewport: { width: config.width, height: config.width === 375 ? 812 : 1000 }, reducedMotion: 'reduce' })
    await context.addInitScript(({ lang, theme }) => {
      localStorage.setItem('aegis-lang', JSON.stringify({ state: { lang }, version: 0 }))
      localStorage.setItem('aegis-theme', JSON.stringify({ state: { theme }, version: 0 }))
    }, config)
    page = await context.newPage(); recordPage(page)
    for (const [name, path] of routeList) {
      await navigate(path)
      const id = `${config.lang}-${config.theme}-${config.width}-${name}`
      const view = await inspect(id)
      assert.equal(view.language, config.lang, `${id}: language hydrated`)
      assert.equal(view.theme, config.theme, `${id}: theme hydrated`)
      if (name === 'robot') assert.match(view.mainText, /QA Inspection 01/)
      if (!baseline && config.width === 1440) {
        await auditAccessibility(id)
        if (['docs', 'integrations', 'sites', 'builder'].includes(name)) {
          await page.locator('main').evaluate((main) => {
            for (const e of [main, ...main.querySelectorAll('*')]) {
              if (/auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1) e.scrollTop = e.scrollHeight
            }
          })
          await inspect(`${id}-bottom`)
          await page.locator('main').evaluate((main) => { for (const e of [main, ...main.querySelectorAll('*')]) e.scrollTop = 0 })
        }
      }
      if (!baseline && name === 'builder') {
        for (const [tool, label] of [['map', /^Map$|^底图$/], ['camera', /^Cameras$|^摄像头$/], ['calibration', /^Calibration$|^标定$/]]) {
          await page.getByRole('radio', { name: label }).click()
          if (tool === 'calibration') {
            await page.getByRole('button', { name: /^Add pair$|^加一组$/i }).click()
            const deletes = page.getByRole('button', { name: /^(Delete|删除) \d+$/ })
            const rows = await deletes.count()
            assert.ok(rows > 0, 'Calibration rows expose distinctly named delete buttons')
          }
          await inspect(`${id}-tool-${tool}`)
          if (config.width === 1440) await auditAccessibility(`${id}-tool-${tool}`)
          if (tool === 'calibration') {
            const deletes = page.getByRole('button', { name: /^(Delete|删除) \d+$/ })
            const rows = await deletes.count()
            await deletes.last().click()
            assert.equal(await deletes.count(), rows - 1, 'Calibration row deletion changes only the intended draft row')
          }
        }
        await page.getByRole('radio', { name: /^Select$|^选择$/i }).click()
        const waypoint = page.getByRole('button', { name: /^WP-/ }).first()
        if (await waypoint.count()) {
          await waypoint.click()
          await inspect(`${id}-waypoint-properties`)
          if (config.width === 1440) await auditAccessibility(`${id}-waypoint-properties`)
        }
      }
      // Every tab in tab-based workspaces is operated, including lazy panels.
      if (!baseline) {
        const tabs = page.getByRole('tab')
        const count = await tabs.count()
        for (let i = 0; i < count; i++) {
          const tab = tabs.nth(i)
          if (!(await tab.isVisible()) || await tab.isDisabled()) continue
          await tab.click()
          await wait(async () => await tab.getAttribute('aria-selected') === 'true', `${id}: tab ${i} selected`)
          await page.waitForTimeout(100)
          await inspect(`${id}-tab-${i}`)
        }
      }
    }
    checks.push(`${config.lang}/${config.theme}/${config.width}: all 12 routes rendered, layout and semantics inspected`)
    console.log(`Inspected ${config.lang}/${config.theme}/${config.width}: ${views.length} views; ${layoutIssues.length} layout/semantics findings`)
    writeFileSync(join(out, 'result.json'), JSON.stringify({ ...evidence, passed: false, running: true, baseline, checks, views, errors, badResponses, layoutIssues, accessibility, failedRequests, externalRequests: [...externalRequests] }, null, 2))
    await context.close()
  }

  if (!baseline) {
    context = await browser.newContext({ storageState: storage, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    page = await context.newPage(); recordPage(page)
    await navigate('/assets')
    await page.getByRole('button', { name: /^add asset$/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await screen('interaction-add-asset-dialog')
    await auditAccessibility('interaction-add-asset-dialog')
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab')
      assert.ok(await dialog.evaluate((e) => e.contains(document.activeElement)), 'Modal keeps keyboard focus inside')
    }
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    try {
      await wait(async () => page.getByRole('button', { name: /^add asset$/i }).evaluate((e) => document.activeElement === e), 'Modal restores trigger focus', 3000)
      checks.push('Dialog keyboard focus trap, Escape dismissal and restored trigger focus')
    } catch (error) { layoutIssues.push({ name: 'interaction-dialog-focus', issue: String(error) }) }

    await page.getByRole('textbox', { name: /search equipment/i }).fill('NO-MATCH-UI-QA')
    await wait(async () => /no equipment|no .*match/i.test(await page.locator('main').innerText()), 'search empty state')
    await inspect('interaction-search-empty')
    expectedResponses.push('503 /robots/api/sites/plant-07/assets')
    await page.route('**/api/sites/plant-07/assets', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary UI test outage' }) }))
    await navigate('/assets')
    await page.getByRole('alert').filter({ hasText: /temporary|failed|503/i }).waitFor()
    await inspect('interaction-api-error')
    await page.unroute('**/api/sites/plant-07/assets')
    await page.getByRole('button', { name: /^retry$/i }).click()
    await page.getByRole('alert').filter({ hasText: /temporary|failed|503/i }).waitFor({ state: 'hidden' })
    checks.push('Filtered empty state, injected API failure with visible error and successful Retry')

    for (const resource of ['integrations', 'connectors']) {
      const path = `/api/sites/plant-07/${resource}`
      const pattern = `**${path}`
      expectedResponses.push(`503 /robots${path}`)
      await page.route(pattern, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary UI test outage' }) }))
      await navigate('/integrations')
      const alert = page.getByRole('alert')
      await alert.waitFor()
      await inspect(`interaction-${resource}-error`)
      await page.unroute(pattern)
      const recovered = page.waitForResponse((r) => new URL(r.url()).pathname === `/robots${path}` && r.ok())
      await alert.getByRole('button', { name: /refresh|刷新/i }).click()
      await recovered
      await alert.waitFor({ state: 'hidden' })
    }
    checks.push('Integration summary and managed connectors show injected API failures and recover through Refresh')
    let slowConnectorRequests = 0
    await page.route('**/api/sites/plant-07/connectors', async (route) => {
      slowConnectorRequests++
      await new Promise((done) => setTimeout(done, 9000))
      await route.continue()
    })
    const slowResult = page.waitForResponse((r) => r.url().endsWith('/api/sites/plant-07/connectors') && r.ok(), { timeout: 18000 })
    await navigate('/integrations')
    const connectorResponse = await slowResult
    assert.deepEqual((await connectorResponse.json()).connectors, [], 'Slow request really returned the empty connector fixture')
    await page.getByText(/no managed connectors|no connectors/i).waitFor({ timeout: 3000 })
    assert.equal(slowConnectorRequests, 1, 'Polling does not start a competing request while the first request is in flight')
    await screen('interaction-connectors-slow-response')
    await page.unroute('**/api/sites/plant-07/connectors')
    checks.push('A real connector response delayed 9 seconds exits loading without a concurrent poll invalidating it')

    await navigate('/docs')
    const platformSpec = await api('GET', '/openapi.json')
    const integrationSpec = await api('GET', '/integration/v1/openapi.json')
    await page.getByText(integrationSpec.info.title, { exact: true }).waitFor()
    await page.getByRole('radio', { name: /platform.*cookie/i }).click()
    await page.getByText(platformSpec.info.title, { exact: true }).waitFor()
    await page.getByRole('radio', { name: /integration.*bearer/i }).click()
    await page.getByText(integrationSpec.info.title, { exact: true }).waitFor()
    const specPattern = '**/api/integration/v1/openapi.json'
    expectedResponses.push('500 /robots/api/integration/v1/openapi.json')
    await page.route(specPattern, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }))
    await navigate('/docs')
    await page.getByRole('alert').waitFor()
    await inspect('interaction-docs-error')
    await page.unroute(specPattern)
    await page.getByRole('alert').getByRole('button', { name: /refresh|刷新/i }).click()
    await page.getByText(integrationSpec.info.title, { exact: true }).waitFor()
    await page.getByRole('alert').waitFor({ state: 'hidden' })
    checks.push('Documentation switches both actual OpenAPI specifications and recovers an injected 500 through Refresh')

    await navigate('/robots/ext-ui-design')
    const payloadVideo = page.locator('main a[href^="/robots/live?src="]').first()
    await payloadVideo.waitFor()
    const videoUrl = await payloadVideo.getAttribute('href')
    assert.equal(await payloadVideo.locator('xpath=ancestor::button').count(), 0, 'Payload link is outside the selection button')
    await payloadVideo.focus(); await page.keyboard.press('Enter')
    await page.waitForURL((u) => `${u.pathname}${u.search}` === videoUrl)
    await page.getByRole('tab', { name: /live video/i }).waitFor()
    checks.push('Payload video link is independently keyboard accessible and reaches its selected live stream')

    await page.getByRole('combobox', { name: /^site$|^场站$/i }).click()
    await page.getByRole('option').filter({ hasText: /campus/i }).click()
    await wait(async () => (await page.getByRole('combobox', { name: /^site$|^场站$/i }).innerText()).toLowerCase().includes('campus'), 'site selection reflected')
    await navigate('/robots')
    assert.equal(await page.getByText('QA Inspection 01', { exact: true }).count(), 0, 'Site switch changes loaded fleet')
    checks.push('Real site selector changes active site and removes previous site fleet')

    await page.getByRole('button', { name: /toggle.*light|theme|明暗/i }).click()
    const theme = await page.locator('html').getAttribute('data-theme')
    await page.reload()
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme, 'Theme persists on reload')
    await page.getByRole('radio', { name: '中文', exact: true }).click()
    await wait(async () => await page.locator('html').getAttribute('lang') === 'zh', 'language control updates html lang')
    await page.reload()
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh', 'Language persists on reload')
    checks.push('Real theme and language controls update the application and persist after reload')

    await page.setViewportSize({ width: 375, height: 812 })
    for (const path of ['/live', '/missions', '/robots', '/map', '/events', '/assets', '/integrations', '/sites', '/docs', '/']) {
      let link = page.locator(`nav a[href="/robots${path === '/' ? '' : path}"], nav a[href="/robots${path}"]`).filter({ visible: true }).first()
      if (!(await link.count())) {
        await page.getByRole('button', { name: /more|更多/i }).click()
        link = page.locator(`a[href="/robots${path === '/' ? '' : path}"], a[href="/robots${path}"]`).filter({ visible: true }).first()
      }
      await link.click()
      await page.waitForURL((u) => u.pathname.replace(/\/$/, '') === `/robots${path === '/' ? '' : path}`)
      await wait(async () => (await page.locator('main').innerText()).trim().length > 10, `mobile nav ${path}`)
    }
    checks.push('All 10 modules reachable through real mobile navigation and More menu')

    for (const position of ['top', 'bottom', 'hidden']) {
      await navigate(`/assets?embed=1&embednav=${position}&site=plant-07`)
      assert.equal(await page.locator('.top-bar:visible,.side-rail:visible,.mobile-nav:visible').count(), 0, 'Embed hides full application chrome')
      assert.equal(await page.locator('.embed-nav:visible').count(), position === 'hidden' ? 0 : 1)
      await inspect(`interaction-embed-${position}`)
    }
    await navigate('/assets?embed=0')
    assert.equal(await page.locator('.top-bar:visible').count(), 1, 'Embed exit restores chrome')
    checks.push('Embedding top/bottom/hidden navigation, pinned site and explicit exit')
    const host = await context.newPage(); recordPage(host)
    for (const position of ['top', 'bottom', 'hidden']) {
      await host.setContent(`<iframe title="Plantbot inspection" style="border:0;width:100%;height:720px" src="${base}/assets?embed=1&embednav=${position}&site=plant-07"></iframe>`)
      const frame = host.frameLocator('iframe')
      await frame.locator('main').getByRole('heading', { name: /Equipment & tags|设备与位号/ }).waitFor()
      assert.equal(await frame.locator('.embed-nav:visible').count(), position === 'hidden' ? 0 : 1)
      assert.equal(await frame.locator('.top-bar:visible,.side-rail:visible,.mobile-nav:visible').count(), 0)
      await screen(`interaction-actual-iframe-${position}`, host)
    }
    await host.close()
    checks.push('Actual iframe host renders the pinned-site workspace in all three navigation modes')
    await context.close()
    context = await browser.newContext({ viewport: { width: 375, height: 812 } })
    page = await context.newPage(); recordPage(page)
    await navigate('/login')
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'Fresh sessions use the Tier0 light workspace')
    await inspect('interaction-login-mobile')
    await auditAccessibility('interaction-login-mobile')
    await page.locator('#login-user').fill('admin')
    await page.locator('#login-pass').fill('wrong-password')
    expectedResponses.push('401 /robots/api/auth/login')
    await page.locator('form button[type=submit]').click()
    await wait(async () => /invalid credentials/i.test(await page.locator('main').innerText()), 'failed login error')
    await inspect('interaction-login-error')
    checks.push('Unauthenticated mobile login and visible rejected-credential feedback')
    await navigate('/unknown-ui-test-route')
    await page.getByRole('heading', { name: /page not found|not found|页面不存在/i }).waitFor()
    await inspect('interaction-not-found')
    await auditAccessibility('interaction-not-found')
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: /skip.*content|跳到.*内容/i })
    await skip.focus()
    await page.keyboard.press('Enter')
    await wait(async () => page.locator('main').evaluate((e) => document.activeElement === e), 'Skip link focuses main content')
    checks.push('Unknown-route recovery and keyboard skip link focus the main workspace')
    assert.deepEqual(errors, [], 'No JavaScript or unexpected console errors')
    assert.deepEqual(badResponses, [], 'No unexpected failed API, media or asset responses')
    assert.deepEqual(failedRequests, [], 'No failed browser requests')
    assert.deepEqual([...externalRequests], [], 'UI resources do not depend on third-party network requests')
    assert.deepEqual(layoutIssues, [], 'No overflow, unnamed controls or missing content')
    const serious = accessibility.filter((r) => r.violations.some((v) => ['critical', 'serious'].includes(v.impact)))
    assert.equal(serious.length, 0, `Serious/critical WCAG findings in ${serious.map((r) => r.name).join(', ')}; see result.json`)
  }
  assert.equal(bundleHash(), evidence.bundleSha256, 'Production bundle changed during the run; repeat against one immutable build')
  const result = { ...evidence, completedAt: new Date().toISOString(), passed: !baseline, baseline, checks, views, errors, badResponses, layoutIssues, accessibility, failedRequests, externalRequests: [...externalRequests] }
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: result.passed, baseline, checks, views: views.length, errors, badResponses }, null, 2))
} catch (error) {
  await page?.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {})
  writeFileSync(join(out, 'result.json'), JSON.stringify({ ...evidence, completedAt: new Date().toISOString(), passed: false, baseline, checks, views, error: String(error), errors, badResponses, layoutIssues, accessibility, failedRequests, externalRequests: [...externalRequests], serverLog }, null, 2))
  console.error(error); process.exitCode = 1
} finally {
  clearInterval(fixtureTimer)
  await browser?.close()
  for (const socket of sockets) socket.destroy()
  await new Promise((done) => proxy.close(done))
  if (proc.exitCode === null) { const closed = once(proc, 'close'); proc.kill('SIGTERM'); await closed }
  rmSync(data, { recursive: true, force: true })
}
