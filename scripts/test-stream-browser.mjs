#!/usr/bin/env node
// WEB_BASE=/robots/ pnpm build && node scripts/test-stream-browser.mjs
// PB_STREAM_BROWSERS=chromium,firefox,webkit,webkit-iphone selects cases.
// Actual RTSP -> go2rtc -> production /robots/ LIVE -> MSE decoded frames.
// The local MP4 is only FFmpeg's input; no browser file-player fallback is accepted.
// iPhone uses Playwright emulation, not physical iOS hardware.
import { chromium, firefox, webkit, devices } from 'playwright'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createServer as createNetServer, connect } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'web/dist'), out = join(root, 'demos/stream-browser-qa')
const source = join(root, 'server/media/perimeter.mp4')
const relayBinary = join(root, 'bin', process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc')
for (const file of [join(dist, 'index.html'), source, relayBinary]) assert.ok(existsSync(file), `Missing ${file}; run setup/build first`)
assert.match(readFileSync(join(dist, 'index.html'), 'utf8'), /\/robots\/assets\//, 'Build with WEB_BASE=/robots/')
const cases = {
  chromium: { engine: chromium }, firefox: { engine: firefox }, webkit: { engine: webkit },
  'webkit-iphone': { engine: webkit, device: 'iPhone 13' },
}
const selected = (process.env.PB_STREAM_BROWSERS ?? Object.keys(cases).join(',')).split(',').map(v => v.trim())
for (const name of selected) assert.ok(cases[name], `Unknown browser case ${name}`)
const data = mkdtempSync(join(tmpdir(), 'pb-stream-browser-'))
mkdirSync(out, { recursive: true })
const children = [], logs = {}, sockets = new Set(), results = []
let browser, proxy, cleaned = false, base
const evidence = {
  startedAt: new Date().toISOString(), bundleSha256: createHash('sha256').update(readFileSync(join(dist, 'index.html'))).digest('hex'),
  source: 'Local perimeter.mp4 -> FFmpeg H.264 640x360 15 fps -> RTSP/TCP ingest -> go2rtc RTSP pull -> MSE WebSocket',
  physicalDeviceTest: false, requested: selected, results,
}
const delay = ms => new Promise(done => setTimeout(done, ms))
const wait = async (fn, label, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await delay(150) }
  throw new Error(`Timed out: ${label}`)
}
const freePort = async () => {
  const s = createNetServer()
  await new Promise((done, fail) => { s.once('error', fail); s.listen(0, '127.0.0.1', done) })
  const port = s.address().port
  await new Promise(done => s.close(done))
  return port
}
const launch = (name, command, args, env = {}) => {
  logs[name] = ''
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.on('error', error => { logs[name] += String(error) })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs[name] = (logs[name] + bytes).slice(-50000) })
  return child
}
const cleanup = async () => {
  if (cleaned) return
  cleaned = true
  await browser?.close().catch(() => {})
  for (const socket of sockets) socket.destroy()
  await new Promise(done => { if (proxy?.listening) proxy.close(done); else done() })
  for (const child of children) {
    try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM') } catch {}
  }
  await delay(350)
  for (const child of children) {
    try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch {}
  }
  rmSync(data, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(130)) })
const save = () => {
  evidence.completedAt = new Date().toISOString()
  evidence.passed = !evidence.error && results.length === selected.length && results.every(r => r.passed)
  writeFileSync(join(out, 'result.json'), JSON.stringify(evidence, null, 2))
  for (const [name, value] of Object.entries(logs)) writeFileSync(join(out, `${name}.log`), value)
}

try {
  const apiPort = await freePort(), relayPort = await freePort(), rtspPort = await freePort()
  evidence.ports = { api: apiPort, relay: relayPort, rtsp: rtspPort }
  const relayUrl = `http://127.0.0.1:${relayPort}`, rtspUrl = `rtsp://127.0.0.1:${rtspPort}/browser-fixture`
  const config = join(data, 'go2rtc.yaml')
  writeFileSync(config, `log:\n  level: info\napi:\n  listen: "127.0.0.1:${relayPort}"\nrtsp:\n  listen: "127.0.0.1:${rtspPort}"\nwebrtc:\n  listen: ""\nstreams:\n  browser-fixture: []\n`)
  launch('relay', relayBinary, ['-config', config])
  await wait(async () => { try { return (await fetch(`${relayUrl}/api`, { signal: AbortSignal.timeout(2000) })).ok } catch { return false } }, 'isolated go2rtc ready')
  const ffmpeg = launch('ffmpeg', process.env.FFMPEG_BIN ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'warning', '-re', '-stream_loop', '-1', '-i', source,
    '-an', '-vf', 'scale=640:360', '-r', '15', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-threads', '2', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level', '3.0', '-g', '15', '-bf', '0',
    '-rtsp_transport', 'tcp', '-f', 'rtsp', rtspUrl,
  ])
  await wait(async () => {
    assert.equal(ffmpeg.exitCode, null, `FFmpeg exited: ${logs.ffmpeg}`)
    const streams = await (await fetch(`${relayUrl}/api/streams`, { signal: AbortSignal.timeout(2000) })).json()
    return streams['browser-fixture']?.producers?.some(p => p.medias?.some(m => m.includes('H264')))
  }, 'real RTSP producer with H.264')
  launch('platform', join(root, 'server/node_modules/.bin/tsx'), ['server/src/index.ts'], {
    API_PORT: String(apiPort), API_HOST: '127.0.0.1', PB_DATA_DIR: data, PB_DEMO: '1', PB_DEV_KEYS: '1',
    PB_PUBLIC_VIEW: '1', PUBLIC_BASE: '/robots', SESSION_SECRET: 'isolated-stream-browser-test', MEDIA_RELAY: relayUrl,
  })
  await wait(async () => { try { return (await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(2000) })).ok } catch { return false } }, 'isolated API ready')
  const upstreamFor = raw => raw.startsWith('/robots/stream/')
    ? { port: relayPort, path: raw.slice('/robots/stream'.length) }
    : { port: apiPort, path: raw.slice('/robots'.length) || '/' }
  proxy = createServer((req, res) => {
    if (!/^\/robots(?:\/|\?|$)/.test(req.url)) { res.writeHead(404); res.end(); return }
    const url = req.url.slice('/robots'.length) || '/'
    if (/^\/(api|media|stream)\//.test(url)) {
      const target = upstreamFor(req.url)
      const upstream = request({ hostname: '127.0.0.1', ...target, method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res)
      })
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      req.pipe(upstream); return
    }
    const file = resolve(dist, `.${decodeURIComponent(url.split('?')[0])}`)
    const target = file.startsWith(`${dist}/`) && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html')
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
    res.setHeader('content-type', mime[extname(target)] ?? 'application/octet-stream'); res.end(readFileSync(target))
  })
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  proxy.on('upgrade', (req, socket, head) => {
    const target = upstreamFor(req.url)
    const upstream = connect(target.port, '127.0.0.1', () => {
      upstream.write(`${req.method} ${target.path} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream))
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
  })
  await new Promise(done => proxy.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${proxy.address().port}/robots`
  evidence.ports.web = proxy.address().port
  let camera
  for (const name of selected) {
    const spec = cases[name]
    const result = { name, passed: false, device: spec.device ?? 'desktop', deviceEmulation: !!spec.device, consoleErrors: [], nativeMediaProbe: [], pageErrors: [], pageErrorDetails: [], mediaLifecycle: [], navigations: [], websocket: [], sessions: [], playback: [] }
    results.push(result)
    let context, page
    try {
      browser = await spec.engine.launch({ headless: true, ...(name === 'chromium' ? { channel: 'chrome' } : {}) })
      result.version = browser.version()
      context = await browser.newContext({ ...(spec.device ? devices[spec.device] : { viewport: { width: 1280, height: 900 } }), reducedMotion: 'reduce' })
      if (spec.device) {
        // macOS WebKit's iPhone emulation can fail to draw its internal media
        // placard icons. Reproduce on about:blank without application code before
        // classifying any exact matching diagnostics from LIVE. Decode failures
        // and all other console/page errors remain blocking.
        // Source: WebKit/Source/WebCore/Modules/modern-media-controls/controls/button.js
        const probe = await context.newPage()
        probe.on('console', message => { if (message.type() === 'error') result.nativeMediaProbe.push({ text: message.text(), location: message.location() }) })
        await probe.goto('about:blank')
        await probe.evaluate(() => {
          const video = document.createElement('video')
          video.controls = true; video.playsInline = true; video.preload = 'auto'
          document.body.appendChild(video)
          video.controls = false; video.muted = true; video.autoplay = true; video.disableRemotePlayback = true
          if ('ManagedMediaSource' in window) video.srcObject = new ManagedMediaSource()
          video.play().catch(() => {})
          setTimeout(() => { video.srcObject = null; video.removeAttribute('src'); video.load() }, 300)
        })
        await delay(650)
        await probe.close()
      }
      const auth = await context.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'plantbot' } })
      assert.ok(auth.ok(), `Fixture login failed: ${await auth.text()}`)
      if (!camera) {
        const created = await context.request.post(`${base}/api/sites/plant-07/cameras`, { data: { name: 'Browser RTSP fixture', rtsp: rtspUrl, place: 'Isolated browser test' } })
        assert.ok(created.ok(), `Create RTSP camera: ${await created.text()}`)
        camera = (await created.json()).camera
      }
      page = await context.newPage()
      page.on('pageerror', error => { result.pageErrors.push(error.message); result.pageErrorDetails.push({ at: Date.now(), url: page.url(), phase: result.phase, name: error.name, message: error.message, stack: error.stack }) })
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) result.navigations.push({ url: frame.url(), at: Date.now() }) })
      page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push({ text: message.text(), location: message.location() }) })
      page.on('websocket', ws => {
        if (!ws.url().includes('/stream/api/ws')) return
        const item = { url: ws.url(), pageUrl: page.url(), openedAt: Date.now(), sent: [], received: [], binaryFrames: 0, closed: false }
        result.websocket.push(item)
        ws.on('framesent', ({ payload }) => { if (typeof payload === 'string') item.sent.push(payload) })
        ws.on('framereceived', ({ payload }) => { if (typeof payload === 'string') item.received.push(payload); else item.binaryFrames++ })
        ws.on('close', () => { item.closed = true; item.closedAt = Date.now() })
        ws.on('socketerror', error => { item.error = String(error) })
      })
      page.on('response', response => {
        if (/\/channels\/[^/]+\/sessions$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST') {
          void response.json().then(body => result.sessions.push(body.session)).catch(() => {})
        }
      })
      await page.addInitScript(() => {
        localStorage.setItem('aegis-lang', JSON.stringify({ state: { lang: 'en' }, version: 0 }))
        localStorage.setItem('aegis-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 }))
        // Diagnostic only: preserve all native semantics and rethrow the same
        // exception. Relate detached SourceBuffer failures to the owning media
        // source without relaxing the uncaught-error gate.
        window.__streamMediaLifecycle = []
        window.__streamBuffers = []
        const owners = new WeakMap(), seen = new WeakSet()
        const record = (type, extra = {}) => {
          window.__streamMediaLifecycle.push({ at: Date.now(), url: location.href, type, ...extra })
          if (window.__streamMediaLifecycle.length > 250) window.__streamMediaLifecycle.shift()
        }
        for (const Constructor of [window.MediaSource, window.ManagedMediaSource]) {
          if (!Constructor) continue
          const prototype = Constructor.prototype
          // ManagedMediaSource may inherit the already wrapped method.
          if (!Object.hasOwn(prototype, 'addSourceBuffer')) continue
          const add = prototype.addSourceBuffer
          prototype.addSourceBuffer = function(...args) {
            const source = this, buffer = Reflect.apply(add, source, args)
            owners.set(buffer, source)
            window.__streamBuffers.push({ buffer, source })
            if (!seen.has(source)) {
              seen.add(source)
              for (const type of ['sourceopen', 'sourceended', 'sourceclose']) source.addEventListener(type, () => record(type, { readyState: source.readyState, bufferCount: source.sourceBuffers.length }))
            }
            record('addSourceBuffer', { readyState: source.readyState, codecs: args[0] })
            buffer.addEventListener('updateend', () => {
              if (source.readyState !== 'open' || !Array.from(source.sourceBuffers).includes(buffer))
                record('detached-updateend', { readyState: source.readyState, bufferCount: source.sourceBuffers.length, present: Array.from(source.sourceBuffers).includes(buffer), updating: buffer.updating })
            })
            return buffer
          }
        }
        const descriptor = window.SourceBuffer && Object.getOwnPropertyDescriptor(SourceBuffer.prototype, 'buffered')
        if (descriptor?.get && descriptor.configurable) Object.defineProperty(SourceBuffer.prototype, 'buffered', {
          ...descriptor,
          get() {
            try { return Reflect.apply(descriptor.get, this, []) }
            catch (error) {
              const source = owners.get(this)
              record('buffered-getter-threw', { name: error.name, message: error.message, stack: error.stack, readyState: source?.readyState, bufferCount: source?.sourceBuffers.length, present: source ? Array.from(source.sourceBuffers).includes(this) : null, updating: this.updating })
              throw error
            }
          },
        })
      })
      const activate = async locator => { if (spec.device) await locator.tap(); else await locator.click() }
      const navigateModule = async path => {
        let link = page.locator(`a[href="/robots${path}"]:visible`).first()
        if (!await link.count()) {
          await activate(page.locator('.mobile-more-trigger'))
          link = page.locator(`a[href="/robots${path}"]:visible`).first()
        }
        await activate(link)
        await page.waitForURL(url => url.pathname === `/robots${path}`)
      }
      for (const phase of ['initial', 'remount']) {
        result.phase = phase
        if (phase === 'initial') {
          await page.goto(`${base}/live?src=${encodeURIComponent(camera.stream)}`, { waitUntil: 'domcontentloaded' })
        } else {
          // Actual SPA navigation tests React unmount/remount. Consecutive hard
          // gotos instead destroy the observation context and race unrelated
          // startup requests while the previous document is being torn down.
          await navigateModule('/live')
          await activate(page.getByRole('button', { name: camera.name, exact: true }))
        }
        await page.locator('video-stream').waitFor({ state: 'visible', timeout: 15000 })
        await page.waitForFunction(stream => {
          const el = document.querySelector('video-stream')
          return el?.wsURL && new URL(el.wsURL).searchParams.get('src') === stream
        }, `plant-07-${camera.stream}`)
        await page.locator('video-stream').scrollIntoViewIfNeeded()
        result.capabilities = await page.evaluate(() => ({ mediaSource: 'MediaSource' in window, managedMediaSource: 'ManagedMediaSource' in window,
          h264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'), videoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype, userAgent: navigator.userAgent }))
        await page.evaluate(() => {
          const video = document.querySelector('video-stream').video
          window.__streamFrames = { callbacks: 0, presentedFrames: 0, mediaTime: 0 }
          if (video.requestVideoFrameCallback) {
            const frame = (_, metadata) => {
              window.__streamFrames.callbacks++; window.__streamFrames.presentedFrames = metadata.presentedFrames; window.__streamFrames.mediaTime = metadata.mediaTime
              video.requestVideoFrameCallback(frame)
            }
            video.requestVideoFrameCallback(frame)
          }
        })
        const sample = () => page.evaluate(() => {
          const el = document.querySelector('video-stream'), video = el?.video
          if (!video) return null
          return { mode: el.mode, readyState: video.readyState, currentTime: video.currentTime, paused: video.paused, width: video.videoWidth, height: video.videoHeight,
            decodedFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount ?? null,
            callbacks: window.__streamFrames.callbacks, presentedFrames: window.__streamFrames.presentedFrames, mediaTime: window.__streamFrames.mediaTime,
            src: video.currentSrc, srcObject: video.srcObject?.constructor?.name ?? null, videoError: video.error ? { code: video.error.code, message: video.error.message } : null }
        })
        let first, last
        try {
          await wait(async () => { first = await sample(); return first?.readyState >= 2 && first.width > 0 && !first.paused }, `${name} ${phase}: decoded first RTSP/MSE frame`, 25000)
          await wait(async () => {
            last = await sample()
            const decoded = last.decodedFrames !== null && first.decodedFrames !== null && last.decodedFrames - first.decodedFrames >= 5
            return last.currentTime - first.currentTime >= 1.5 && (decoded || last.callbacks - first.callbacks >= 5)
          }, `${name} ${phase}: decoded frames and time advance`, 15000)
        } finally { result.playback.push({ phase, first: first ?? null, last: last ?? await sample() }) }
        assert.equal(last.mode, 'mse', 'The actual production MSE mode is required')
        assert.ok(last.src.startsWith('blob:') || last.srcObject === 'ManagedMediaSource', 'A real MSE object must back playback')
        const pixelRange = await page.evaluate(() => {
          const video = document.querySelector('video-stream').video, canvas = document.createElement('canvas')
          canvas.width = 64; canvas.height = 36
          const c = canvas.getContext('2d'); c.drawImage(video, 0, 0, 64, 36)
          const pixels = c.getImageData(0, 0, 64, 36).data
          let min = 255, max = 0
          for (let i = 0; i < pixels.length; i += 4) { const v = pixels[i] + pixels[i + 1] + pixels[i + 2]; min = Math.min(min, v / 3); max = Math.max(max, v / 3) }
          return max - min
        })
        assert.ok(pixelRange > 10, `Decoded camera image is not a blank frame: range ${pixelRange}`)
        result.playback.at(-1).pixelRange = pixelRange
        await page.screenshot({ path: join(out, `${name}-${phase}.png`) })
        if (phase === 'initial') {
          result.phase = 'leave-live-spa'
          const previousSockets = result.websocket.slice()
          await navigateModule('/assets')
          await page.getByRole('heading', { name: 'Equipment & tags', exact: true }).waitFor()
          assert.equal(await page.locator('video-stream').count(), 0, 'Leaving LIVE removes its video component')
          await wait(async () => previousSockets.every(ws => ws.closed), `${name}: leaving LIVE closes the MSE socket`, 8000)
          let consumers
          await wait(async () => {
            const streams = await (await fetch(`${relayUrl}/api/streams`, { signal: AbortSignal.timeout(2000) })).json()
            consumers = streams[`plant-07-${camera.stream}`]?.consumers ?? []
            return consumers.length === 0
          }, `${name}: go2rtc confirms leaving LIVE released the MSE consumer`, 8000)
          result.playback.at(-1).cleanup = { destinationRendered: '/assets', videoComponentRemoved: true, observedSocketClosed: true, relayConsumers: consumers }
          if (process.env.PB_STREAM_STALE_CALLBACK_PROBE === '1') {
            // Deterministically replay a queued updateend on the actual retired
            // RTSP SourceBuffer. This supplements natural SPA cleanup; it does
            // not substitute for decoded playback or observed socket closure.
            result.staleCallbackProbe = await page.evaluate(() => window.__streamBuffers.map(({ buffer, source }) => {
              const before = { readyState: source.readyState, bufferCount: source.sourceBuffers.length, present: Array.from(source.sourceBuffers).includes(buffer) }
              buffer.dispatchEvent(new Event('updateend'))
              return before
            }))
          }
          result.mediaLifecycle = await page.evaluate(() => window.__streamMediaLifecycle)
        }
      }
      assert.ok(result.websocket.some(ws => ws.sent.some(message => JSON.parse(message).type === 'mse') && ws.binaryFrames > 0), 'go2rtc MSE negotiation and fMP4 payloads observed')
      result.mediaLifecycle = await page.evaluate(() => window.__streamMediaLifecycle)
      const testedSessions = result.sessions.filter(s => s.channelId === `cam:${camera.id}`)
      assert.ok(testedSessions.length >= 2 && testedSessions.every(s => s.protocol === 'mse' && s.relayOnline === true && s.expiresAt !== null), 'Actual RTSP playback leases, never a file session')
      assert.deepEqual(result.pageErrors, [], 'No uncaught player errors')
      const diagnosticSignature = item => item.location.url === '' && /^Button failed to load, iconName = (invalid|pip|airplay)-placard, layoutTraits = \[MacOSLayoutTraits Inline\], src = blob:/.test(item.text)
        ? item.text.replace(/, src = blob:.+$/, '') : null
      const nativeSignatures = new Set(result.nativeMediaProbe.map(diagnosticSignature).filter(Boolean))
      result.browserDiagnostics = result.consoleErrors.filter(item => nativeSignatures.has(diagnosticSignature(item)))
      result.applicationConsoleErrors = result.consoleErrors.filter(item => !nativeSignatures.has(diagnosticSignature(item)))
      if (result.browserDiagnostics.length) result.diagnosticNote = 'WebKit native media placard icon errors independently reproduced on about:blank without Plantbot. Raw logs retained; playback, decoded frames, image pixels and application errors are independently asserted.'
      assert.deepEqual(result.applicationConsoleErrors, [], 'No application or unclassified browser console errors')
      result.passed = true
    } catch (error) {
      result.error = String(error)
      if (page) { result.mediaLifecycle = await page.evaluate(() => window.__streamMediaLifecycle).catch(() => []); result.visibleText = await page.locator('main').innerText().catch(() => ''); await page.screenshot({ path: join(out, `${name}-failed.png`) }).catch(() => {}) }
    } finally {
      await context?.close().catch(() => {})
      await browser?.close().catch(() => {}); browser = undefined
      save()
      console.log(JSON.stringify({ browser: name, passed: result.passed, error: result.error, playback: result.playback }))
    }
  }
  evidence.relayStreams = await (await fetch(`${relayUrl}/api/streams`, { signal: AbortSignal.timeout(2000) })).json()
  assert.equal(createHash('sha256').update(readFileSync(join(dist, 'index.html'))).digest('hex'), evidence.bundleSha256, 'Production bundle must not change during browser matrix')
} catch (error) { evidence.error = String(error) }
finally { save(); await cleanup() }
if (!evidence.passed || evidence.error) process.exitCode = 1
console.log(JSON.stringify({ passed: evidence.passed && !evidence.error, error: evidence.error, results: results.map(r => ({ name: r.name, passed: r.passed, error: r.error })), artifact: join(out, 'result.json') }, null, 2))
