#!/usr/bin/env node
// Exercise the actual Vite proxy and bundled go2rtc on isolated loopback ports.
// No platform, user data, live camera, or Origin-rewriting workaround is used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const requireWeb = createRequire(join(root, 'web/package.json'))
const requireIntegrations = createRequire(join(root, 'integrations/package.json'))
const { createServer, loadConfigFromFile } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
const WebSocket = requireIntegrations('ws')
const work = mkdtempSync(join(tmpdir(), 'pb-dev-stream-'))
const out = join(root, 'demos/dev-stream-qa')
mkdirSync(out, { recursive: true })
let relay, vite, relayLog = '', outcome
const checks = [], forwarded = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function freePort() {
  const server = createNetServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function handshake(url, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin, family: 4, handshakeTimeout: 5000 })
    let settled = false
    const complete = value => { if (!settled) { settled = true; resolve(value) } }
    socket.once('open', () => { complete({ status: 101, url, origin }); socket.close(1000) })
    socket.once('unexpected-response', (_request, response) => {
      let body = ''
      response.on('data', data => { body += data })
      response.once('end', () => { complete({ status: response.statusCode, url, origin, body }); socket.terminate() })
    })
    socket.on('error', error => { if (!settled) { settled = true; reject(error) } })
  })
}

try {
  const relayPort = await freePort(), vitePort = await freePort()
  const relayBase = `http://127.0.0.1:${relayPort}`
  const configPath = join(work, 'go2rtc.yaml')
  writeFileSync(configPath, `log:\n  level: trace\napi:\n  listen: "127.0.0.1:${relayPort}"\nrtsp:\n  listen: ""\nwebrtc:\n  listen: ""\n`)
  const binary = join(root, 'bin', process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc')
  assert.ok(existsSync(binary), 'Run pnpm run setup to install go2rtc')
  relay = spawn(binary, ['-config', configPath], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
  relay.on('error', error => { relayLog += String(error) })
  for (const stream of [relay.stdout, relay.stderr]) stream.on('data', data => { relayLog += data })
  let ready = false
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try { ready = (await fetch(`${relayBase}/api`, { signal: AbortSignal.timeout(1000) })).ok } catch {}
    if (ready) break
    if (relay.exitCode !== null) throw new Error(`go2rtc exited: ${relayLog}`)
    await delay(100)
  }
  assert.ok(ready, `go2rtc did not start: ${relayLog}`)
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, join(root, 'web/vite.config.ts'))
  assert.ok(loaded, 'Load the actual repository Vite configuration')
  const playback = loaded.config.server.proxy['/stream/api/ws']
  assert.ok(playback && typeof playback === 'object')
  assert.notEqual(playback.rewriteWsOrigin, true, 'Never bypass the relay Origin check')
  const observe = (proxy, options) => {
    playback.configure?.(proxy, options)
    for (const event of ['proxyReq', 'proxyReqWs']) proxy.on(event, (request, incoming) => {
      forwarded.push({ event, method: incoming.method, path: request.path, host: request.getHeader('host'), origin: request.getHeader('origin') ?? null })
    })
  }
  const createVite = async (port, changeOrigin = playback.changeOrigin) => {
    const server = await createServer({ ...loaded.config, configFile: false, root: join(root, 'web'), cacheDir: join(work, `vite-${port}`),
      server: { ...loaded.config.server, host: '127.0.0.1', port, strictPort: true,
        proxy: { ...loaded.config.server.proxy, '/stream/api/ws': { ...playback, target: relayBase, changeOrigin, configure: observe } } } })
    await server.listen()
    return server
  }
  vite = await createVite(vitePort)
  for (const host of ['localhost', '127.0.0.1']) {
    const authority = `${host}:${vitePort}`
    const result = await handshake(`ws://${authority}/stream/api/ws`, `http://${authority}`)
    assert.equal(result.status, 101, JSON.stringify(result))
    const request = forwarded.at(-1)
    assert.equal(request.host, authority)
    assert.equal(request.origin, `http://${authority}`)
    checks.push({ check: 'same-origin upgrade preserves Host and Origin', ...result, forwarded: request })
  }
  const evil = await handshake(`ws://127.0.0.1:${vitePort}/stream/api/ws`, 'https://evil.example')
  assert.equal(evil.status, 403, JSON.stringify(evil))
  assert.match(evil.body, /Forbidden/i)
  assert.equal(forwarded.at(-1).origin, 'https://evil.example')
  checks.push({ check: 'cross-origin upgrade rejected by the real relay', ...evil })
  const directManagement = await fetch(`${relayBase}/api/streams`)
  assert.equal(directManagement.status, 200, 'The isolated relay management endpoint really exists')
  for (const [method, path] of [['GET', '/stream/api/streams'], ['GET', '/stream/api/config'], ['PUT', '/stream/api/streams?name=should-not-exist&src=invalid']]) {
    const before = forwarded.length
    const response = await fetch(`http://127.0.0.1:${vitePort}${path}`, { method, headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
    const body = await response.text()
    assert.equal(forwarded.length, before, `${method} ${path} must not reach go2rtc`)
    assert.ok(response.status === 404 || response.headers.get('content-type')?.includes('text/html'), `${path}: ${response.status} ${body}`)
    checks.push({ check: 'management endpoint is outside Vite relay proxy', method, path, status: response.status })
  }
  assert.deepEqual(await (await fetch(`${relayBase}/api/streams`)).json(), {}, 'Denied management request created no relay stream')
  await vite.close(); vite = null
  // Negative control proves that the previous Host rewrite causes this exact failure.
  const oldPort = await freePort()
  vite = await createVite(oldPort, true)
  const rewritten = await handshake(`ws://localhost:${oldPort}/stream/api/ws`, `http://localhost:${oldPort}`)
  assert.equal(rewritten.status, 403, JSON.stringify(rewritten))
  assert.equal(forwarded.at(-1).host, `127.0.0.1:${relayPort}`)
  assert.equal(forwarded.at(-1).origin, `http://localhost:${oldPort}`)
  checks.push({ check: 'negative control: changeOrigin=true reproduces the old 403', ...rewritten, forwarded: forwarded.at(-1) })
  outcome = { passed: true, checks, boundary: 'Real Vite + go2rtc WebSocket handshake/security gate; browser media decoding is tested separately.' }
} catch (error) {
  outcome = { passed: false, error: String(error), checks, forwarded }
  process.exitCode = 1
} finally {
  await vite?.close()
  if (relay?.pid && relay.exitCode === null && relay.signalCode === null) {
    relay.kill('SIGTERM')
    await Promise.race([once(relay, 'exit'), delay(2000)])
    if (relay.exitCode === null && relay.signalCode === null) { relay.kill('SIGKILL'); await once(relay, 'exit') }
  }
  writeFileSync(join(out, 'result.json'), JSON.stringify(outcome, null, 2)+'\n')
  writeFileSync(join(out, 'relay.log'), relayLog)
  rmSync(work, { recursive: true, force: true })
}
console.log(JSON.stringify(outcome, null, 2))
