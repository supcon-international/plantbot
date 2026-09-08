#!/usr/bin/env node
// WEB_BASE=/robots/ pnpm build && node scripts/test-tier0-ui.mjs
// TIER0_UI_BASELINE=1 records the pre-change design without accepting it as passing.
// TIER0_UI_BROWSER=chromium|firefox|webkit selects an engine (Chromium uses installed Chrome).
// TIER0_UI_DEVICES=1 uses that engine's native Playwright mobile/tablet descriptors.
// Device emulation is not physical-device testing. Touch actions use tap. WebKit
// mobile scrolling uses DOM scrollBy because Playwright does not support its wheel.
// Uses a temporary database and dynamically allocated ports. No robot is commanded.
import { chromium, firefox, webkit, devices } from 'playwright'
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
const engine = process.env.TIER0_UI_BROWSER ?? 'chromium'
assert.ok(['chromium', 'firefox', 'webkit'].includes(engine), 'TIER0_UI_BROWSER must be chromium, firefox or webkit')
const deviceMode = process.env.TIER0_UI_DEVICES === '1'
assert.ok(!(deviceMode && engine === 'firefox'), 'Playwright Firefox does not support isMobile. Run Firefox without TIER0_UI_DEVICES; use WebKit for iPhone/iPad and Chromium for Pixel.')
const out = join(root, 'demos/tier0-ui-qa', engine, baseline ? 'baseline' : interactionsOnly ? 'interactions' : deviceMode ? 'devices' : 'final')
assert.ok(existsSync(join(dist, 'index.html')), 'Build the production bundle first')
assert.match(readFileSync(join(dist, 'index.html'), 'utf8'), /\/robots\/assets\//, 'Build with WEB_BASE=/robots/')
const bundleHash = () => createHash('sha256').update(readFileSync(join(dist, 'index.html'))).digest('hex')
const evidence = { startedAt: new Date().toISOString(), bundleSha256: bundleHash(), scope: interactionsOnly ? 'interactions' : deviceMode ? 'devices' : 'full',
  browser: { engine, channel: engine === 'chromium' ? 'chrome' : null, version: null, platform: process.platform },
  deviceEmulation: deviceMode, emulationNote: deviceMode ? `Playwright device descriptors; not physical hardware. Trusted taps; ${engine === 'webkit' ? 'programmatic DOM scrolling, since Playwright does not support wheel in mobile WebKit; no swipe claim' : 'native wheel scrolling'}. Rotation changes the viewport within the same touch context.` : null,
  contexts: [], cacheDiagnostics: [], cancellationDiagnostics: [], unloadDiagnostics: [], mediaCancellationDiagnostics: [], mediaPlaybackProofs: [],
}
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
const upstreamSockets = new Set()
const proxy = createServer((req, res) => {
  if (!/^\/robots(?:\/|\?|$)/.test(req.url)) { res.writeHead(404); res.end(); return }
  const url = req.url.slice(7) || '/'
  if (url === '/__ui-test-host') {
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>')
    return
  }
  if (/^\/(api|media)\//.test(url)) {
    const upstream = request({ hostname: '127.0.0.1', port: apiPort, path: url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res)
    })
    upstream.on('socket', (socket) => {
      if (!upstreamSockets.has(socket)) { upstreamSockets.add(socket); socket.once('close', () => upstreamSockets.delete(socket)) }
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
  upstreamSockets.add(upstream); upstream.once('close', () => upstreamSockets.delete(upstream))
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
})

let browser, page, fixtureTimer, base, context, currentDevice = null
const checks = [], views = [], errors = [], badResponses = [], expectedResponses = [], layoutIssues = [], accessibility = [], failedRequests = [], externalRequests = new Set()
const pageLifecycle = new WeakMap(), requestLifecycle = new WeakMap()
let nextPageId = 0
const goTo = async (p, url, options) => {
  const state = pageLifecycle.get(p)
  if (state) state.pendingNavigation = url
  try { return await p.goto(url, options) } finally { if (state) state.pendingNavigation = null }
}
const reloadPage = async (p) => {
  const state = pageLifecycle.get(p)
  if (state) state.pendingNavigation = p.url()
  try { return await p.reload() } finally { if (state) state.pendingNavigation = null }
}
const closePage = async (p) => { const state = pageLifecycle.get(p); if (state) state.closing = true; await p.close() }
const closeContext = async (c) => { for (const p of c.pages()) { const state = pageLifecycle.get(p); if (state) state.closing = true }; await c.close() }
const recordPage = (p) => {
  const lifecycle = { pageId: ++nextPageId, revision: 0, panelRevision: 0, lastPanelTransition: null, pendingNavigation: null, closing: false }
  pageLifecycle.set(p, lifecycle)
  p.on('framenavigated', () => { lifecycle.revision++ })
  p.on('pageerror', (e) => errors.push({ url: p.url(), error: e.message, stack: e.stack, lifecycle: { ...lifecycle } }))
  p.on('console', (m) => {
    // Failed HTTP responses are separately classified with their exact URL.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource:')) {
      const value = { url: p.url(), error: m.text(), location: m.location(), lifecycle: { ...lifecycle }, args: [] }
      const blobFailure = m.text().match(/^Cannot load (blob:\S+) due to access control checks\.$/)
      // An isolated, non-Plantbot Troika probe reproduces WebKit aborting
      // importScripts only when hard navigation destroys the worker. Retain the
      // exact message, but never classify it while the page is stable.
      if (engine === 'webkit' && lifecycle.pendingNavigation && !m.location().url && blobFailure && new URL(blobFailure[1]).origin === new URL(base).origin) {
        evidence.unloadDiagnostics.push({ type: 'Troika worker destroyed by explicit hard navigation', ...value })
        return
      }
      errors.push(value)
      Promise.all(m.args().map((arg) => arg.jsonValue().catch(() => '[context disposed]'))).then((args) => { value.args = args })
    }
  })
  p.on('response', (r) => {
    const meta = requestLifecycle.get(r.request())
    if (meta) { meta.responseStatus = r.status(); meta.responseRange = r.headers()['content-range'] ?? null }
    if (r.status() < 400 || !r.url().startsWith(base)) return
    const value = `${r.status()} ${new URL(r.url()).pathname}`
    if (expectedResponses.includes(value)) return
    badResponses.push({ page: p.url(), response: value })
  })
  p.on('request', (r) => {
    if (/^https?:/.test(r.url()) && !r.url().startsWith(base)) externalRequests.add(r.url())
    let frameUrl = null
    try { frameUrl = r.frame().url() } catch {}
    requestLifecycle.set(r, { pageId: lifecycle.pageId, revision: lifecycle.revision, panelRevision: lifecycle.panelRevision, pageUrl: p.url(), frameUrl, range: r.headers()['range'] ?? null })
  })
  p.on('requestfailed', (r) => {
    // Mozilla's NetworkUtils classifies this exact status as already-in-cache.
    // Keep diagnostics and restrict classification to local Firefox media loads.
    // https://searchfox.org/mozilla-central/source/devtools/shared/network-observer/NetworkUtils.sys.mjs
    if (engine === 'firefox' && r.url().startsWith(`${base}/media/`) && r.failure()?.errorText === 'NS_ERROR_PARSED_DATA_CACHED') {
      evidence.cacheDiagnostics.push({ page: p.url(), url: r.url(), status: 'NS_ERROR_PARSED_DATA_CACHED' })
      return
    }
    const error = r.failure()?.errorText, start = requestLifecycle.get(r)
    let frameUrl = null
    try { frameUrl = r.frame().url() } catch {}
    const reason = lifecycle.closing ? 'page/context closing' : lifecycle.pendingNavigation ? 'explicit navigation in progress'
      : start && (start.revision !== lifecycle.revision || start.frameUrl !== frameUrl) ? 'request crossed a frame navigation'
      : start && start.panelRevision !== lifecycle.panelRevision ? 'request crossed an operated tab transition' : null
    if (engine === 'webkit' && error === 'cancelled' && r.url().startsWith('blob:') && new URL(r.url()).origin === new URL(base).origin && lifecycle.pendingNavigation) {
      evidence.unloadDiagnostics.push({ type: 'same-origin worker blob cancelled by explicit hard navigation', page: p.url(), url: r.url(), error, requestStarted: start, lifecycle: { ...lifecycle } })
      return
    }
    // Keep Chromium's existing explicit-abort classification. WebKit's differently
    // named status is accepted only for local assets/media across a known lifecycle
    // transition; an unexplained cancellation remains a failing request.
    const lifecycleAbort = (engine === 'webkit' && error === 'cancelled') || (engine === 'firefox' && error === 'NS_BINDING_ABORTED')
    const pathname = new URL(r.url()).pathname
    const localResource = /^\/robots\/(assets|media)\//.test(pathname)
      || (r.resourceType() === 'image' && pathname.startsWith('/robots/api/snapshots/'))
    if (error?.includes('ERR_ABORTED') || (lifecycleAbort && localResource && r.url().startsWith(base) && reason)) {
      evidence.cancellationDiagnostics.push({ page: p.url(), url: r.url(), error, reason: reason ?? 'Chromium explicit request abort', requestStarted: start, ...(reason === 'request crossed an operated tab transition' ? { transition: lifecycle.lastPanelTransition } : {}) })
      return
    }
    failedRequests.push({ page: p.url(), url: r.url(), error, failedAt: Date.now(), requestStarted: start, lifecycle: { ...lifecycle }, frameUrl })
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
const collectMediaPlaybackProof = async (p = page) => {
  if (engine !== 'webkit' || new URL(p.url()).pathname !== '/robots/live') return
  const sample = () => p.locator('video').evaluateAll((videos) => videos.flatMap((v) => {
    const r = v.getBoundingClientRect(), src = v.currentSrc || v.src
    if (!src || r.width <= 0 || r.height <= 0) return []
    const url = new URL(src); url.hash = ''
    if (url.origin !== location.origin || !url.pathname.startsWith('/robots/media/')) return []
    return [{ url: url.href, autoplay: v.autoplay, time: v.currentTime, frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
      readyState: v.readyState, width: v.videoWidth, height: v.videoHeight, error: v.error?.message ?? null }]
  }))
  let before = await sample()
  if (!before.length) return
  let after = before
  await wait(async () => {
    after = await sample()
    if (after.length !== before.length || after.some((video, i) => video.url !== before[i].url || video.autoplay !== before[i].autoplay)) {
      before = after
      return false
    }
    return after.length > 0 && after.every((video, i) => {
      const first = before[i]
      return video.url === first.url && !video.error && video.width > 0 && video.height > 0 && (video.autoplay
        ? video.readyState >= 2 && (video.time > first.time + .02 || (video.frames ?? 0) > (first.frames ?? 0))
        : video.readyState >= 1)
    })
  }, 'WebKit Live media loads metadata and active players advance their real decoded video', 15000)
  const lifecycle = pageLifecycle.get(p)
  for (let i = 0; i < after.length; i++) {
    const video = after[i], first = before[i]
    evidence.mediaPlaybackProofs.push({ pageId: lifecycle.pageId, revision: lifecycle.revision, recordedAt: Date.now(), pageUrl: p.url(), url: video.url,
      decoded: video.readyState >= 2 && ((video.frames ?? 0) > 0 || video.time > first.time + .02), before: first, after: video })
  }
}
const inspect = async (name, p = page) => {
  await collectMediaPlaybackProof(p)
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
      browserEnvironment: { userAgent: navigator.userAgent, deviceScaleFactor: devicePixelRatio, maxTouchPoints: navigator.maxTouchPoints,
        screen: { width: screen.width, height: screen.height }, visualViewport: { width: visualViewport?.width, height: visualViewport?.height, scale: visualViewport?.scale },
        coarsePointer: matchMedia('(pointer: coarse)').matches, hover: matchMedia('(hover: hover)').matches },
      mainText: main?.innerText.slice(0, 300), headings: [...document.querySelectorAll('h1')].filter(visible).map((e) => e.textContent),
      rootOverflow: document.documentElement.scrollWidth - innerWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
      unnamedControls: controls.filter((e) => !name(e)).map(describe), clippedControls,
      tinyControls: controls.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 24 || r.height < 24 }).map(describe),
    }
  })
  views.push({ name, url: p.url(), viewport: p.viewportSize(), device: currentDevice, ...result })
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
  await goTo(p, `${base}${path}`, { waitUntil: 'domcontentloaded' })
  await p.locator('main').waitFor()
  await wait(async () => (await p.locator('main').innerText()).trim().length > 10, `route ${path} rendered`)
  await p.evaluate(() => document.fonts.ready)
  if (path.split('?')[0] === '/') {
    const robotCard = p.getByRole('link', { name: /^QA Inspection 01/ }).first()
    await robotCard.waitFor()
    await wait(async () => (await robotCard.innerText()).includes('85%'), 'Overview has received the live fixture battery')
    await robotCard.getByText(/steady|稳定/i).waitFor()
  }
  if (path.split('?')[0].startsWith('/robots/')) {
    // Wait for the live telemetry history before axe takes its DOM snapshot.
    // A skeleton can otherwise become a text-bearing Spark during the scan.
    await p.getByText(/steady|稳定/i).first().waitFor()
    await wait(async () => p.locator('main .skeleton:visible').count().then((n) => n === 0), 'Robot detail telemetry and model ready', 30000)
  }
  if (['/', '/map'].includes(path.split('?')[0])) {
    const canvas = p.locator('main canvas').first()
    await canvas.waitFor({ state: 'visible', timeout: 30000 })
    await wait(async () => canvas.evaluate((c) => c.width > 300 && c.getBoundingClientRect().width >= Math.min(301, innerWidth - 32)), `route ${path}: real map canvas fills the available narrow viewport`, 30000)
    await wait(async () => p.locator('main .skeleton:visible').count().then((n) => n === 0), `route ${path}: map loading completed`, 30000)
    // Give the WebGL scene a rendered frame after fonts and local geometry load.
    await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    if (!baseline) {
      await wait(async () => {
        const png = await canvas.screenshot()
        return p.evaluate(async (base64) => {
          const bitmap = new Image()
          await new Promise((done, reject) => { bitmap.onload = done; bitmap.onerror = reject; bitmap.src = `data:image/png;base64,${base64}` })
          const probe = document.createElement('canvas'); probe.width = bitmap.naturalWidth; probe.height = bitmap.naturalHeight
          const ctx = probe.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0)
          const { data } = ctx.getImageData(0, 0, probe.width, probe.height)
          const colors = new Set()
          for (let i = 0; i < data.length; i += 64) colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`)
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
const deviceCase = (name, descriptor, lang, theme, viewport) => {
  const { defaultBrowserType, ...options } = devices[descriptor]
  return { name, descriptor, lang, theme, engine: defaultBrowserType,
    width: (viewport ?? options.viewport).width,
    options: { ...options, ...(viewport ? { viewport, screen: viewport } : {}) },
    viewportOverride: viewport ?? null,
  }
}
const deviceCases = [
  deviceCase('iphone-se-portrait', 'iPhone SE', 'en', 'light'),
  deviceCase('iphone13-portrait', 'iPhone 13', 'zh', 'light'),
  deviceCase('iphone13-landscape', 'iPhone 13 landscape', 'en', 'dark', { width: 844, height: 390 }),
  deviceCase('iphone15-portrait', 'iPhone 15', 'zh', 'dark'),
  deviceCase('pixel7-portrait', 'Pixel 7', 'zh', 'light'),
  deviceCase('pixel7-landscape', 'Pixel 7 landscape', 'en', 'dark'),
  deviceCase('ipad-portrait', 'iPad (gen 6)', 'en', 'dark'),
  deviceCase('ipad-landscape', 'iPad (gen 6) landscape', 'zh', 'light'),
]
const activate = async (locator) => {
  if (await locator.getAttribute('role') === 'tab' && await locator.getAttribute('aria-selected') !== 'true') {
    const state = pageLifecycle.get(page)
    if (state) {
      state.panelRevision++
      state.lastPanelTransition = { role: 'tab', name: await locator.innerText(), pageUrl: page.url() }
    }
  }
  return currentDevice ? locator.tap() : locator.click()
}
const scrollContainerToEnd = async (locator, direction = 'y', p = page) => {
  await locator.scrollIntoViewIfNeeded()
  const measure = () => locator.evaluate((e) => ({ x: e.scrollLeft, y: e.scrollTop, maxX: e.scrollWidth - e.clientWidth, maxY: e.scrollHeight - e.clientHeight }))
  const initial = await measure()
  const max = direction === 'x' ? initial.maxX : initial.maxY
  assert.ok(max > 1, `Expected a real ${direction}-scrollable container`)
  const box = await locator.boundingBox()
  assert.ok(box && box.width > 0 && box.height > 0, 'Scrollable content has a visible viewport')
  // Fixed navigation can cover part of a scroller even after scrollIntoView.
  // Hit-test the actual input point instead of sending wheel events through chrome.
  const point = await locator.evaluate((e) => {
    const r = e.getBoundingClientRect()
    for (let y = Math.max(r.top + 4, 4); y < Math.min(r.bottom - 4, innerHeight - 4); y += 8) {
      for (const x of [r.left + Math.min(r.width / 2, 100), r.left + 8]) {
        const hit = document.elementFromPoint(x, y)
        if (hit && e.contains(hit)) return { x, y }
      }
    }
    return null
  })
  assert.ok(point, 'Scrollable content exposes an unobscured input area')
  await p.mouse.move(point.x, point.y)
  for (let i = 0; i < 12; i++) {
    const state = await measure()
    if ((direction === 'x' ? state.maxX - state.x : state.maxY - state.y) <= 2) return state
    if (currentDevice && engine === 'webkit') {
      await locator.evaluate((e, { direction, amount }) => e.scrollBy(direction === 'x' ? amount : 0, direction === 'y' ? amount : 0), { direction, amount: Math.max(600, max) })
    } else {
      await p.mouse.wheel(direction === 'x' ? Math.max(600, max) : 0, direction === 'y' ? Math.max(600, max) : 0)
    }
    await p.waitForTimeout(120)
  }
  const final = await measure()
  assert.ok((direction === 'x' ? final.maxX - final.x : final.maxY - final.y) <= 2, `${currentDevice && engine === 'webkit' ? 'DOM scrollBy' : 'Native wheel'} did not reach the ${direction} scroll end: ${JSON.stringify(final)}`)
  return final
}
const contentScrollers = async (p = page) => p.locator('main').evaluate((main) => {
  const nodes = [main, ...main.querySelectorAll('*')]
  return nodes.flatMap((e, i) => {
    if (e.clientHeight > 60 && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 2) {
      e.setAttribute('data-ui-audit-scroll', String(i))
      return [String(i)]
    }
    return []
  })
})
const touchWorkspace = async (config) => {
  const name = `${config.name}-${config.lang}-${config.theme}`
  await navigate('/assets')
  await activate(page.getByRole('button', { name: /^Add asset$|^添加设备$/i }))
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await inspect(`${name}-touch-dialog`)
  await auditAccessibility(`${name}-touch-dialog`)
  // A touch user must be able to dismiss a long form without a hardware Escape key.
  await activate(dialog.getByRole('button', { name: /^Close$|^关闭$/i }).first())
  await dialog.waitFor({ state: 'hidden' })
  await navigate('/robots')
  const settings = page.getByRole('button', { name: /application controls|应用设置/i })
  if (await settings.isVisible()) {
    await activate(settings)
    const popover = page.locator('[data-slot="popover-content"]')
    await popover.waitFor()
    await activate(popover.getByRole('button', { name: /toggle.*light|theme|明暗/i }))
    const changed = await page.locator('html').getAttribute('data-theme')
    assert.notEqual(changed, config.theme, 'Touch theme action changes the current theme')
    await activate(popover.getByRole('button', { name: /toggle.*light|theme|明暗/i }))
    assert.equal(await page.locator('html').getAttribute('data-theme'), config.theme)
    await activate(settings)
    await popover.waitFor({ state: 'hidden' })
  }
  for (const path of ['/live', '/missions', '/robots', '/map', '/events', '/assets', '/integrations', '/sites', '/docs', '/']) {
    let link = page.locator(`nav a[href="/robots${path === '/' ? '' : path}"], nav a[href="/robots${path}"]`).filter({ visible: true }).first()
    if (!(await link.count())) {
      await activate(page.getByRole('button', { name: /more|更多/i }))
      link = page.locator(`a[href="/robots${path === '/' ? '' : path}"], a[href="/robots${path}"]`).filter({ visible: true }).first()
    }
    await link.scrollIntoViewIfNeeded()
    const bounds = await link.boundingBox(), viewport = page.viewportSize()
    assert.ok(bounds && bounds.y >= -1 && bounds.y + bounds.height <= viewport.height + 1, `Touch navigation ${path} must scroll into the visible viewport`)
    await activate(link)
    await page.waitForURL((u) => u.pathname.replace(/\/$/, '') === `/robots${path === '/' ? '' : path}`)
    await page.locator('[data-slot="popover-content"]').waitFor({ state: 'hidden' })
    await wait(async () => (await page.locator('main').innerText()).trim().length > 10, `${name}: touch route ${path}`)
    if (path === '/live') await collectMediaPlaybackProof(page)
  }
  // Fleet's real data table overflows on phones. Verify its own scroll container moves,
  // while the page-level no-overflow check remains enforced separately.
  await navigate('/robots')
  const table = page.locator('main [data-slot="table-container"]').first()
  if (config.width < 560) assert.ok(await table.count(), 'Phone fleet view retains its scrollable data table')
  if (await table.count()) {
    const overflow = await table.evaluate((e) => e.scrollWidth - e.clientWidth)
    if (config.width < 560) assert.ok(overflow > 1, 'Phone data table provides a real horizontal scrolling region')
    if (overflow > 1) {
      await scrollContainerToEnd(table, 'x')
      await inspect(`${name}-table-scrolled-right`)
    }
  }
  await navigate('/docs')
  const scrollers = await contentScrollers()
  assert.ok(scrollers.length > 0, 'Documentation provides a real content scrolling region')
  for (const id of scrollers) await scrollContainerToEnd(page.locator(`[data-ui-audit-scroll="${id}"]`))
  await inspect(`${name}-touch-documentation-bottom`)
  const original = page.viewportSize()
  const rotated = { width: original.height, height: original.width }
  await page.setViewportSize(rotated)
  await inspect(`${name}-rotated`)
  const documentationLink = page.locator('nav a[href="/robots/docs"]').filter({ visible: true }).first()
  if (await documentationLink.count()) {
    await documentationLink.scrollIntoViewIfNeeded()
    const box = await documentationLink.boundingBox()
    assert.ok(box.y >= -1 && box.y + box.height <= rotated.height + 1, 'Last sidebar entry remains reachable after rotation')
    await activate(documentationLink)
  }
  await page.setViewportSize(original)
  await navigate('/assets?embed=1&embednav=bottom&site=plant-07')
  await inspect(`${name}-touch-embed`)
  const frameNav = page.locator('.embed-nav')
  const frameLink = frameNav.locator('a[href="/robots/events"]')
  await activate(frameLink)
  await page.waitForURL((u) => u.pathname === '/robots/events')
  assert.equal(await page.locator('.top-bar:visible,.side-rail:visible,.mobile-nav:visible').count(), 0)
  await navigate('/assets?embed=0')
  const host = await context.newPage(); recordPage(host)
  await goTo(host, `${base}/__ui-test-host`)
  await host.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;width:100%;height:100%}</style><iframe title="Plantbot touch workspace" style="display:block;border:0;width:100%;height:${Math.max(300, original.height - 30)}px" src="${base}/assets?embed=1&embednav=bottom&site=plant-07"></iframe>`)
  const frame = host.frameLocator('iframe')
  await frame.locator('main').getByRole('heading', { name: /Equipment & tags|设备与位号/ }).waitFor()
  await frame.locator('body').evaluate(() => {
    window.__plantbotQaTouchEvents = []
    for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, (e) => window.__plantbotQaTouchEvents.push({ type, trusted: e.isTrusted, target: e.target.outerHTML?.slice(0, 300) }), true)
  })
  await screen(`${name}-actual-touch-iframe-before`, host)
  await frame.locator('.embed-nav a[href="/robots/events"]').tap()
  try {
    await wait(async () => host.frames().some((f) => f.url().startsWith(`${base}/events`)), 'Actual iframe touch navigation changes the frame URL')
  } catch (error) {
    await screen(`${name}-actual-touch-iframe-failure`, host)
    evidence.iframeFailure = { urls: host.frames().map((f) => f.url()), events: await frame.locator('body').evaluate(() => window.__plantbotQaTouchEvents), text: await frame.locator('main').innerText() }
    throw error
  }
  await wait(async () => await frame.locator('.embed-nav a[href="/robots/events"]').getAttribute('aria-current') === 'page', 'Actual iframe updates its active module')
  await wait(async () => (await frame.locator('main').innerText()).trim().length > 30, 'Actual iframe events content rendered')
  await screen(`${name}-actual-touch-iframe`, host)
  await closePage(host)
  checks.push(`${name}: touch dialog, settings, all navigation entries, scrolling, rotation and actual iframe`)
}
const verifyBuilderPointerCancellation = async () => {
  await navigate('/sites/plant-07')
  const svg = page.locator('main svg.touch-none')
  const markers = svg.locator(':scope > g[style*="cursor: pointer"]')
  assert.ok(await markers.count() > 1, 'Builder exposes the seeded waypoint geometry')
  const markerIndex = await markers.evaluateAll((nodes) => nodes.findIndex((e) => e.querySelector(':scope > rect')))
  assert.ok(markerIndex >= 0, 'Builder has a solid inspection waypoint for a precise cross-browser drag')
  const marker = markers.nth(markerIndex)
  const coordinates = () => markers.evaluateAll((nodes) => nodes.map((e) => e.getAttribute('transform')))
  const dragStart = async () => {
    await marker.scrollIntoViewIfNeeded()
    // Use the filled inspection marker's centre. Thin, unfilled transit circles
    // have no centre hit target and edge hits vary with native pixel rounding.
    const point = await marker.evaluate((e) => {
      const r = e.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const hit = document.elementFromPoint(x, y)
      return hit && e.contains(hit) ? { x, y } : null
    })
    assert.ok(point, 'The waypoint has a painted, unobscured drag target')
    await page.evaluate(() => document.addEventListener('pointerdown', (e) => { window.__plantbotQaPointerId = e.pointerId; window.__plantbotQaPointerTarget = e.target }, { once: true, capture: true }))
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    assert.ok(await marker.evaluate((e) => e.contains(window.__plantbotQaPointerTarget)), 'The native pointerdown landed on the intended inspection waypoint')
    return { ...point, pointerId: await page.evaluate(() => window.__plantbotQaPointerId) }
  }
  const before = await coordinates()
  const start = await dragStart()
  await page.mouse.move(start.x + 24, start.y + 12)
  await wait(async () => (await coordinates())[markerIndex] !== before[markerIndex], 'Primary pointer really moved its waypoint')
  const moved = await coordinates()
  const secondId = start.pointerId + 100
  await markers.nth((markerIndex + 1) % await markers.count()).dispatchEvent('pointerdown', { pointerId: secondId, pointerType: 'touch', isPrimary: false, button: 0, buttons: 1, clientX: start.x + 50, clientY: start.y + 20 })
  await svg.dispatchEvent('pointermove', { pointerId: secondId, pointerType: 'touch', isPrimary: false, buttons: 1, clientX: start.x + 100, clientY: start.y + 70 })
  assert.deepEqual(await coordinates(), moved, 'A second pointer cannot capture or move either waypoint')
  // Start with a genuine active mouse pointer so native setPointerCapture has a
  // valid pointer id. Only cancellation and the second-contact events are synthetic.
  await svg.dispatchEvent('pointercancel', { pointerId: start.pointerId, pointerType: 'mouse', isPrimary: true, buttons: 0 })
  await page.mouse.move(start.x + 65, start.y + 35)
  assert.deepEqual(await coordinates(), moved, 'Pointer movement after pointercancel cannot alter draft coordinates')
  await page.mouse.up()
  const next = await dragStart()
  await svg.dispatchEvent('lostpointercapture', { pointerId: next.pointerId, pointerType: 'mouse', isPrimary: true, buttons: 0 })
  const lost = await coordinates()
  await page.mouse.move(next.x + 30, next.y + 20)
  assert.deepEqual(await coordinates(), lost, 'Pointer movement after lost capture cannot alter draft coordinates')
  await page.mouse.up()
  await page.getByRole('radio', { name: /waypoint|航点/i }).click()
  const count = await page.getByRole('button', { name: /^WP-/ }).count()
  const b = await svg.boundingBox()
  await svg.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch', isPrimary: false, button: 0, buttons: 1, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 })
  assert.equal(await page.getByRole('button', { name: /^WP-/ }).count(), count, 'A secondary touch does not create another waypoint')
  await screen('interaction-builder-pointer-cancellation')
  checks.push('Builder: real primary drag, synthetic pointercancel/lost capture, and a second contact cannot continue or hijack the edit')
}
const verifySafeAreas = async (storage) => {
  if (engine !== 'chromium' || !deviceMode) return
  for (const scenario of [
    { name: 'safe-area-portrait', viewport: { width: 375, height: 812 }, insets: { top: 47, bottom: 34, left: 0, right: 0 } },
    { name: 'safe-area-landscape', viewport: { width: 844, height: 390 }, insets: { top: 0, bottom: 21, left: 47, right: 47 } },
  ]) {
    const options = { ...deviceCases.find((c) => c.name === 'iphone13-portrait').options, viewport: scenario.viewport, screen: scenario.viewport }
    currentDevice = { name: scenario.name, isMobile: true, hasTouch: true, deviceScaleFactor: options.deviceScaleFactor, safeAreaInsets: scenario.insets, emulation: 'Chrome CDP CSS safe-area override' }
    context = await browser.newContext({ ...options, storageState: storage, reducedMotion: 'reduce' })
    evidence.contexts.push({ device: currentDevice, options })
    page = await context.newPage(); recordPage(page)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: scenario.insets })
    await navigate('/assets')
    const actual = await page.evaluate(() => {
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
      document.body.append(el)
      const s = getComputedStyle(el)
      const value = { top: parseFloat(s.paddingTop), right: parseFloat(s.paddingRight), bottom: parseFloat(s.paddingBottom), left: parseFloat(s.paddingLeft) }
      el.remove(); return value
    })
    assert.deepEqual(actual, scenario.insets, 'CSS env() really receives the injected safe-area insets')
    const within = async (locator, label) => {
      await locator.scrollIntoViewIfNeeded()
      const r = await locator.boundingBox(), s = scenario.insets, v = scenario.viewport
      assert.ok(r && r.x >= s.left - 1 && r.x + r.width <= v.width - s.right + 1 && r.y >= s.top - 1 && r.y + r.height <= v.height - s.bottom + 1,
        `${scenario.name}: ${label} falls outside the usable safe area: ${JSON.stringify(r)}`)
    }
    for (const control of await page.locator('.top-bar button:visible,.top-bar h1:visible,.mobile-nav a:visible,.mobile-nav button:visible').all()) await within(control, 'header or navigation control')
    const lastSideLink = page.locator('.side-nav a[href="/robots/docs"]')
    if (await lastSideLink.isVisible()) { await within(lastSideLink, 'last sidebar entry'); await activate(lastSideLink); await page.waitForURL((u) => u.pathname === '/robots/docs'); await navigate('/assets') }
    const add = page.getByRole('button', { name: /^Add asset$/i })
    await within(add, 'primary action'); await activate(add)
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await dialog.getByRole('textbox', { name: /equipment name/i }).fill(`UI ${scenario.name}`)
    await dialog.getByRole('textbox', { name: /equipment type/i }).fill('UI safe-area fixture')
    if (await dialog.evaluate((e) => e.scrollHeight > e.clientHeight + 2)) await scrollContainerToEnd(dialog)
    const save = dialog.getByRole('button', { name: /^Save asset$/i })
    await within(save, 'dialog Save action')
    await screen(`${scenario.name}-dialog-save`)
    await activate(save)
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('heading', { name: `UI ${scenario.name}`, exact: true }).waitFor()
    await inspect(`${scenario.name}-saved`)
    checks.push(`${scenario.name}: verified CSS insets, header, navigation, primary action and successful dialog Save stay within safe bounds`)
    for (const nav of ['top', 'bottom', 'hidden']) {
      await navigate(`/assets?embed=1&embednav=${nav}&site=plant-07`)
      assert.equal(await page.locator('main').evaluate((el) => getComputedStyle(el).marginLeft), '0px', 'Embedding does not apply the standalone sidebar offset twice')
      await within(page.locator('main').getByRole('heading', { name: /Equipment & tags|设备与位号/ }).first(), 'embedded content heading')
      if (nav !== 'hidden') {
        for (const link of await page.locator('.embed-nav a').all()) await within(link, `${nav} embedded navigation`)
      }
      await inspect(`${scenario.name}-embed-${nav}`)
    }
    checks.push(`${scenario.name}: embedded top/bottom/hidden content and navigation respect the same safe areas`)
    // The standalone login uses its own header, so shell coverage alone cannot
    // prove theme/language controls respect the notch and home-indicator bounds.
    await context.clearCookies()
    await navigate('/login?embed=0')
    await page.locator('#login-user').waitFor()
    const loginHeader = async () => {
      const controls = await page.locator('header button:visible').all()
      assert.ok(controls.length >= 3, 'Login exposes theme and both language controls')
      for (const control of controls) await within(control, 'login header theme/language control')
    }
    await loginHeader()
    await activate(page.getByRole('radio', { name: '中文', exact: true }))
    await activate(page.getByRole('button', { name: /toggle.*light|theme|明暗/i }))
    await wait(async () => await page.locator('html').getAttribute('lang') === 'zh' && await page.locator('html').getAttribute('data-theme') === 'dark', 'Login touch controls apply Chinese and dark theme')
    await loginHeader()
    await inspect(`${scenario.name}-login-zh-dark`)
    await activate(page.getByRole('radio', { name: 'English', exact: true }))
    await activate(page.getByRole('button', { name: /toggle.*light|theme|明暗/i }))
    await wait(async () => await page.locator('html').getAttribute('lang') === 'en' && await page.locator('html').getAttribute('data-theme') === 'light', 'Login touch controls restore English and light theme')
    await loginHeader()
    for (const control of await page.locator('#login-user,#login-pass,form button[type=submit]').all()) await within(control, 'reachable login form control')
    await inspect(`${scenario.name}-login-en-light`)
    checks.push(`${scenario.name}: standalone login theme/language taps and form controls remain reachable within safe bounds`)
    await cdp.detach(); await closeContext(context); currentDevice = null
  }
}

try {
  await wait(async () => (await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok, 'isolated API ready')
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${proxy.address().port}/robots`
  browser = await ({ chromium, firefox, webkit }[engine]).launch({ ...(engine === 'chromium' ? { channel: 'chrome' } : {}), headless: true })
  evidence.browser.version = browser.version()
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
  await closeContext(context)

  const desktopConfigs = baseline
    ? [{ lang: 'en', theme: 'dark', width: 1440 }, { lang: 'zh', theme: 'light', width: 375 }]
    : ['en', 'zh'].flatMap((lang) => ['light', 'dark'].flatMap((theme) => [375, 768, 1440].map((width) => ({ lang, theme, width }))))
  const configs = deviceMode ? deviceCases.filter((c) => c.engine === engine) : desktopConfigs
  for (const config of interactionsOnly ? [] : configs) {
    currentDevice = config.name ? { name: config.name, descriptor: config.descriptor, viewportOverride: config.viewportOverride,
      isMobile: config.options.isMobile, hasTouch: config.options.hasTouch, deviceScaleFactor: config.options.deviceScaleFactor, userAgent: config.options.userAgent } : null
    const contextOptions = config.options ?? { viewport: { width: config.width, height: config.width === 375 ? 812 : 1000 } }
    context = await browser.newContext({ storageState: storage, ...contextOptions, reducedMotion: 'reduce' })
    evidence.contexts.push({ device: currentDevice, lang: config.lang, theme: config.theme, options: contextOptions })
    await context.addInitScript(({ lang, theme }) => {
      // A context initially opens about:blank before its real test host loads.
      // Non-web documents must not receive application preference writes.
      if (!['http:', 'https:'].includes(location.protocol)) return
      localStorage.setItem('aegis-lang', JSON.stringify({ state: { lang }, version: 0 }))
      localStorage.setItem('aegis-theme', JSON.stringify({ state: { theme }, version: 0 }))
    }, config)
    page = await context.newPage(); recordPage(page)
    for (const [name, path] of routeList) {
      await navigate(path)
      const id = `${config.name ? `${config.name}-` : ''}${config.lang}-${config.theme}-${config.width}-${name}`
      const view = await inspect(id)
      assert.equal(view.language, config.lang, `${id}: language hydrated`)
      assert.equal(view.theme, config.theme, `${id}: theme hydrated`)
      if (name === 'robot') assert.match(view.mainText, /QA Inspection 01/)
      if (!baseline && (config.width === 1440 || deviceMode)) {
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
          await activate(page.getByRole('radio', { name: label }))
          if (tool === 'calibration') {
            await activate(page.getByRole('button', { name: /^Add pair$|^加一组$/i }))
            const deletes = page.getByRole('button', { name: /^(Delete|删除) \d+$/ })
            const rows = await deletes.count()
            assert.ok(rows > 0, 'Calibration rows expose distinctly named delete buttons')
          }
          await inspect(`${id}-tool-${tool}`)
          if (config.width === 1440 || deviceMode) await auditAccessibility(`${id}-tool-${tool}`)
          if (tool === 'calibration') {
            const deletes = page.getByRole('button', { name: /^(Delete|删除) \d+$/ })
            const rows = await deletes.count()
            await activate(deletes.last())
            assert.equal(await deletes.count(), rows - 1, 'Calibration row deletion changes only the intended draft row')
          }
        }
        await activate(page.getByRole('radio', { name: /^Select$|^选择$/i }))
        const waypoint = page.getByRole('button', { name: /^WP-/ }).first()
        if (await waypoint.count()) {
          await activate(waypoint)
          await inspect(`${id}-waypoint-properties`)
          if (config.width === 1440 || deviceMode) await auditAccessibility(`${id}-waypoint-properties`)
        }
      }
      // Every tab in tab-based workspaces is operated, including lazy panels.
      if (!baseline) {
        const tabs = page.getByRole('tab')
        const count = await tabs.count()
        for (let i = 0; i < count; i++) {
          const tab = tabs.nth(i)
          if (!(await tab.isVisible()) || await tab.isDisabled()) continue
          await activate(tab)
          await wait(async () => await tab.getAttribute('aria-selected') === 'true', `${id}: tab ${i} selected`)
          await page.waitForTimeout(100)
          await inspect(`${id}-tab-${i}`)
        }
      }
    }
    if (deviceMode) await touchWorkspace(config)
    checks.push(`${config.name ? `${config.name}/` : ''}${config.lang}/${config.theme}/${config.width}: all 12 routes rendered, layout and semantics inspected`)
    console.log(`Inspected ${config.lang}/${config.theme}/${config.width}: ${views.length} views; ${layoutIssues.length} layout/semantics findings`)
    writeFileSync(join(out, 'result.json'), JSON.stringify({ ...evidence, passed: false, running: true, baseline, checks, views, errors, badResponses, layoutIssues, accessibility, failedRequests, externalRequests: [...externalRequests] }, null, 2))
    await closeContext(context)
    currentDevice = null
  }
  if (!baseline) await verifySafeAreas(storage)

  if (!baseline) {
    context = await browser.newContext({ storageState: storage, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    page = await context.newPage(); recordPage(page)
    await verifyBuilderPointerCancellation()
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
    await reloadPage(page)
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme, 'Theme persists on reload')
    await page.getByRole('radio', { name: '中文', exact: true }).click()
    await wait(async () => await page.locator('html').getAttribute('lang') === 'zh', 'language control updates html lang')
    await reloadPage(page)
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
    await goTo(host, `${base}/__ui-test-host`)
    for (const position of ['top', 'bottom', 'hidden']) {
      await host.setContent(`<iframe title="Plantbot inspection" style="border:0;width:100%;height:720px" src="${base}/assets?embed=1&embednav=${position}&site=plant-07"></iframe>`)
      const frame = host.frameLocator('iframe')
      await frame.locator('main').getByRole('heading', { name: /Equipment & tags|设备与位号/ }).waitFor()
      assert.equal(await frame.locator('.embed-nav:visible').count(), position === 'hidden' ? 0 : 1)
      assert.equal(await frame.locator('.top-bar:visible,.side-rail:visible,.mobile-nav:visible').count(), 0)
      await screen(`interaction-actual-iframe-${position}`, host)
    }
    await closePage(host)
    checks.push('Actual iframe host renders the pinned-site workspace in all three navigation modes')
    await closeContext(context)
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
    // WebKit may cancel an initial MP4 Range while reopening the metadata tail.
    // Classify only after this very page/document decoded the same URL later.
    for (let i = failedRequests.length - 1; i >= 0; i--) {
      const failure = failedRequests[i]
      if (engine !== 'webkit' || failure.error !== 'cancelled' || !failure.url.startsWith(`${base}/media/`)) continue
      const proof = evidence.mediaPlaybackProofs.find((p) => p.pageId === failure.requestStarted?.pageId && p.revision === failure.requestStarted?.revision
        && p.url === failure.url && p.recordedAt >= failure.failedAt && p.decoded)
      if (proof) { evidence.mediaCancellationDiagnostics.push({ failure, proof }); failedRequests.splice(i, 1) }
    }
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
  // Release this runner's proxy connections if a browser close waits for them.
  // The watchdog is scoped to its own sockets and child, never another service.
  const closeSockets = () => { for (const socket of [...sockets, ...upstreamSockets]) socket.destroy() }
  const childRunning = () => proc.exitCode === null && proc.signalCode === null
  const watchdog = setTimeout(() => { closeSockets(); if (childRunning()) proc.kill('SIGTERM') }, 10000)
  const fatalWatchdog = setTimeout(() => {
    closeSockets(); if (childRunning()) proc.kill('SIGKILL')
    const report = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'))
    writeFileSync(join(out, 'result.json'), JSON.stringify({ ...report, passed: false, teardownError: 'Isolated browser/fixture failed to close within 25 seconds' }, null, 2))
    console.error('Isolated UI runner teardown exceeded 25 seconds')
    process.exit(1)
  }, 25000)
  await browser?.close()
  closeSockets()
  await new Promise((done) => proxy.close(done))
  if (childRunning()) {
    const closed = once(proc, 'close'); proc.kill('SIGTERM')
    const forceChild = setTimeout(() => { if (childRunning()) proc.kill('SIGKILL') }, 3000)
    await closed; clearTimeout(forceChild)
  }
  clearTimeout(watchdog); clearTimeout(fatalWatchdog)
  rmSync(data, { recursive: true, force: true })
}
