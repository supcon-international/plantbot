#!/usr/bin/env node
// Exercise extracted offline packages in disposable projects/volumes. Does not touch a deployed instance.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [serverArchive, adapterArchive, demoArchive] = process.argv.slice(2).map((p) => resolve(p))
if (!serverArchive || !adapterArchive) throw new Error('Pass the Server and Adapter .tar.gz archives')
const work = mkdtempSync(join(tmpdir(), 'pb-release-qa-')),
  suffix = Date.now(),
  serverProject = `pb-qa-server-${suffix}`,
  adapterProject = `pb-qa-adapter-${suffix}`
const out = join(root, 'demos/release-qa')
mkdirSync(out, { recursive: true })
const python = process.env.PB_VISION_PYTHON || join(root, 'integrations/vision/.venv/bin/python')
let serverDir,
  adapterDir,
  sim,
  log = '',
  cookie = ''
const env = { ...process.env }
async function run(command, args, cwd = root, extra = {}) {
  const p = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  p.stdout.on('data', (b) => {
    output += b
    log += b
  })
  p.stderr.on('data', (b) => {
    output += b
    log += b
  })
  const [code] = await once(p, 'exit')
  if (code !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${output.slice(-2000)}`)
  return output.trim()
}
const serverCompose = (...args) =>
  run(
    'docker',
    ['compose', '-p', serverProject, '--env-file', '.env.server', '-f', 'compose.yaml', ...args],
    serverDir,
  )
const adapterCompose = (...args) =>
  run(
    'docker',
    [
      'compose',
      '-p',
      adapterProject,
      '--env-file',
      '.env.adapter',
      '-f',
      'compose.yaml',
      '-f',
      'qa.override.yaml',
      ...args,
    ],
    adapterDir,
  )
const base = 'http://127.0.0.1:18094/robots'
async function api(path, method = 'GET', body) {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const b = await r.json()
  assert.ok(r.ok, JSON.stringify(b))
  return b
}
async function wait(fn, label, timeout = 60000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try {
      const x = await fn()
      if (x) return x
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Timeout: ' + label)
}
const checks = []
try {
  for (const [archive, kind] of [
    [serverArchive, 'server'],
    [adapterArchive, 'adapter'],
  ]) {
    const dest = join(work, kind)
    mkdirSync(dest)
    await run('tar', ['-xzf', archive, '-C', dest])
    const folder = join(dest, readdirSync(dest)[0])
    if (kind === 'server') serverDir = folder
    else adapterDir = folder
    await run('shasum', ['-a', '256', '--check', 'SHA256SUMS'], folder)
  }
  const manifest = JSON.parse(readFileSync(join(serverDir, 'release.json'), 'utf8')),
    other = JSON.parse(readFileSync(join(adapterDir, 'release.json'), 'utf8'))
  assert.equal(manifest.revision, other.revision)
  assert.equal(manifest.version, other.version)
  assert.equal(manifest.platform, 'linux/amd64')
  await run('docker', ['load', '--input', 'images.tar'], adapterDir)
  // A Linux named volume preserves real UID ownership, unlike desktop file sharing.
  const privateConfig = `${adapterProject}-private-config`
  await run('docker', ['volume', 'create', privateConfig])
  try {
    await run('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--platform',
      manifest.platform,
      '--user',
      '0',
      '--entrypoint',
      'node',
      '-v',
      `${privateConfig}:/config`,
      other.images.adapter.tag,
      '-e',
      "const fs=require('node:fs');fs.writeFileSync('/config/adapter.json',JSON.stringify({id:'linux-private'}),{mode:0o600});fs.chownSync('/config/adapter.json',0,0)",
    ])
    for (const service of ['adapter', 'vision']) {
      const command =
        service === 'adapter'
          ? [
              'node',
              '-e',
              "const fs=require('node:fs'),a=require('node:assert/strict'),p=process.env.PB_ADAPTER_CONFIG;a.equal(process.getuid(),1000);a.equal(fs.statSync(p).mode&511,384);a.equal(JSON.parse(fs.readFileSync(p)).id,'linux-private')",
            ]
          : [
              'python',
              '-c',
              "import os,json;from pathlib import Path;p=Path(os.environ['PB_ADAPTER_CONFIG']);assert os.getuid()==1000;assert p.stat().st_mode&0o777==0o600;assert json.loads(p.read_text())['id']=='linux-private'",
            ]
      await run('docker', [
        'run',
        '--rm',
        '--network',
        'none',
        '--platform',
        manifest.platform,
        '-v',
        `${privateConfig}:/config:ro`,
        other.images[service].tag,
        ...command,
      ])
    }
    checks.push('Root-owned Linux configuration remains private; both Adapter runtimes execute as UID 1000')
  } finally {
    await run('docker', ['volume', 'rm', privateConfig])
  }

  await run('bash', ['start.sh'], serverDir, {
    COMPOSE_PROJECT_NAME: serverProject,
    PLANTBOT_PORT: '18094',
    PB_DATA_VOLUME: `${serverProject}-data`,
  })
  const generated = readFileSync(join(serverDir, '.env.server'), 'utf8')
  const password = generated.match(/^PB_ADMIN_PASSWORD=([a-f0-9]{24})$/m)?.[1]
  assert.ok(password, 'First startup generates a strong account password')
  assert.match(generated, /^SESSION_SECRET=[a-f0-9]{64}$/m)
  assert.equal(statSync(join(serverDir, '.env.server')).mode & 0o777, 0o600)
  writeFileSync(
    join(serverDir, '.env.server'),
    generated + `PLANTBOT_PORT=18094\nPB_DATA_VOLUME=${serverProject}-data\n`,
  )
  const health = await api('/health')
  assert.equal(health.demo, false)
  assert.equal(health.sites.length, 0)
  const auth = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  })
  assert.equal(auth.status, 200)
  cookie = auth.headers.get('set-cookie').split(';')[0]
  await api('/sites', 'POST', { id: 'release-qa', name: 'Release QA' })
  const key = (await api('/sites/release-qa/api-keys', 'POST', { label: 'Release QA adapter' })).apiKey.key
  await run(python, ['integrations/vision/tests/make_video.py', join(adapterDir, 'feed.mp4'), '--source', 'instrument'])
  const configuration = {
    id: 'release-edge',
    name: 'Release QA adapter',
    serverUrl: 'http://gateway:8080/robots',
    devices: [
      {
        vendor: 'spot',
        config: {
          serial: 'RELEASE-SPOT',
          callsign: 'Release Spot',
          host: 'host.docker.internal',
          port: '19453',
          user: 'admin',
          pass: 'spotdev2026',
        },
      },
    ],
    sources: [{ id: 'display', label: 'QA display', view: 'fixed', url: '/config/feed.mp4', loop: true }],
  }
  writeFileSync(join(adapterDir, 'adapter.json'), JSON.stringify(configuration), { mode: 0o600 })
  writeFileSync(
    join(adapterDir, '.env.adapter'),
    `PB_SITE_KEY=${key}\nPB_ADAPTER_VOLUME=${adapterProject}-vision\n`,
    { mode: 0o600 },
  )
  writeFileSync(
    join(adapterDir, 'qa.override.yaml'),
    `services:\n  vision:\n    volumes:\n      - ./feed.mp4:/config/feed.mp4:ro\nnetworks:\n  default:\n    external: true\n    name: ${serverProject}_default\n`,
  )
  const simRoot = resolve(process.env.PLANTBOT_SIM_DIR || join(root, '../plantbotsimulator'))
  sim = spawn(join(simRoot, 'node_modules/.bin/tsx'), ['spot/sim/main.ts'], {
    cwd: simRoot,
    env: { ...env, SPOT_SIM_PORT: '19453', SPOT_SIM_FAULT_S: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  sim.stdout.on('data', (b) => {
    log += b
  })
  sim.stderr.on('data', (b) => {
    log += b
  })
  await adapterCompose('up', '-d', '--wait')
  await wait(async () => {
    const x = await api('/sites/release-qa/vision')
    return x.adapters[0]?.online
  }, 'vision adapter registration')
  const fleet = async () => {
    const r = await fetch(base + '/api/integration/v1/fleet', { headers: { authorization: `Bearer ${key}` } })
    assert.ok(r.ok)
    return r.json()
  }
  await wait(
    async () => (await fleet()).robots.some((r) => r.id === 'ext-release-spot'),
    'standalone vendor adapter registers native simulator',
  )
  const rule = await api('/sites/release-qa/vision/configs', 'POST', {
    name: 'QA recorded IR display',
    preset: 'ocr',
    adapterId: 'release-edge',
    sourceId: 'display',
    enabled: true,
    numeric: true,
    unit: '℃',
    max: 33,
    confidence: 0.5,
    region: [
      [0.7, 0.12],
      [1, 0.12],
      [1, 0.5],
      [0.7, 0.5],
    ],
    intervalS: 1,
  })
  const observed = await wait(async () => {
    const x = await api('/sites/release-qa/vision')
    return x.results.find((r) => r.config.id === rule.id && !r.jobId && !r.late && [33.1, 33.2, 34.3].includes(r.value) && r.status === 'alert' && r.eventId)
  }, 'Linux container OCR and alarm')
  const image = await fetch('http://127.0.0.1:18094' + observed.evidence, { headers: { cookie } })
  assert.equal(image.status, 200)
  assert.ok((await image.arrayBuffer()).byteLength > 1000)
  checks.push(
    'Extracted package checksums, empty production bootstrap, site/key creation, actual Linux Adapter inference and protected evidence',
  )
  await api('/sites/release-qa/robots/ext-release-spot/goto', 'POST', { x: 6, z: 3 })
  await wait(async () => {
    const x = await fleet()
    const t = x.telemetry.find((r) => r.id === 'ext-release-spot')
    return t && Math.hypot(t.x - 6, t.z - 3) < 0.8
  }, 'native navigation through standalone Adapter')
  await adapterCompose('stop', 'vision')
  await api('/sites/release-qa/robots/ext-release-spot/goto', 'POST', { x: 3, z: 2 })
  await wait(async () => {
    const x = await fleet()
    const t = x.telemetry.find((r) => r.id === 'ext-release-spot')
    return t && Math.hypot(t.x - 3, t.z - 2) < 0.8
  }, 'robot navigation continues with vision stopped')
  checks.push('Shared vendor configuration, native navigation and process isolation when vision stops')
  await adapterCompose('up', '-d', 'vision')
  await serverCompose('restart', 'api')
  await wait(
    async () => (await api('/sites/release-qa/vision')).adapters[0]?.online,
    'automatic reconnection after Server restart',
  )
  const restored = await api('/sites/release-qa/vision')
  assert.ok(restored.results.some((r) => r.id === observed.id))
  assert.equal(restored.configs[0].id, rule.id)
  checks.push('Server restart preserves configuration/history and Adapter reconnects automatically')
  if (demoArchive) {
    await run(process.execPath, ['scripts/test-demo-package.mjs', demoArchive], root)
    const demo = JSON.parse(readFileSync(join(root, 'demos/demo-package-qa/result.json'), 'utf8'))
    assert.equal(demo.passed, true)
    assert.equal(demo.revision, manifest.revision)
    assert.equal(demo.version, manifest.version)
    checks.push('Matching offline Adapter Demo package passed native fleet, actual vision transitions, evidence and idempotent bootstrap tests')
  }
  writeFileSync(
    join(out, 'result.json'),
    JSON.stringify({ passed: true, version: manifest.version, revision: manifest.revision, checks }, null, 2),
  )
  console.log(JSON.stringify({ passed: true, checks }, null, 2))
} catch (error) {
  writeFileSync(
    join(out, 'result.json'),
    JSON.stringify({ passed: false, error: String(error), checks, log }, null, 2),
  )
  console.error(error)
  process.exitCode = 1
} finally {
  if (adapterDir) await adapterCompose('down', '-v').catch(() => {})
  if (serverDir) await serverCompose('down', '-v').catch(() => {})
  if (sim?.exitCode === null) {
    const ended = once(sim, 'exit')
    sim.kill('SIGTERM')
    await ended
  }
  rmSync(work, { recursive: true, force: true })
}
