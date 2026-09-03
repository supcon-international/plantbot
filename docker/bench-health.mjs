#!/usr/bin/env node

import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const base = (process.env.PLANTBOT_BASE ?? 'http://api:8787').replace(/\/$/, '')
const sites = [
  { id: 'plant-07', key: process.env.PB_DEMO_KEY_PLANT07, robots: ['ext-bd-91250107'] },
  { id: 'plant-12', key: process.env.PB_DEMO_KEY_PLANT12, robots: ['ext-x30-jy-2024-0007'] },
  {
    id: 'campus-east',
    key: process.env.PB_DEMO_KEY_CAMPUSEAST,
    robots: [
      'ext-bd-91250203',
      'ext-x30-jy-2024-0031',
      'ext-gscn-f2-2024-0117',
      'ext-gscn-f2-2024-0118',
    ],
  },
]

const tcpReady = (port) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => socket.destroy(new Error(`timeout on ${port}`)), 1500)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

async function deepReady() {
  const webUrl = process.env.PB_READY_WEB_URL ?? 'http://gateway:8080/robots/'
  const rtspUrl = process.env.PB_READY_RTSP_URL ?? 'rtsp://bench:8554/switchgear.mp4'

  const page = await fetch(webUrl, { signal: AbortSignal.timeout(5_000) })
  if (!page.ok) throw new Error(`SPA returned ${page.status}`)
  const html = await page.text()
  if (!/<div id=["']root["']><\/div>/.test(html)) throw new Error('SPA root element is missing')
  const scriptSrc = /<script[^>]+src=["']([^"']+)["']/.exec(html)?.[1]
  if (!scriptSrc?.startsWith('/robots/assets/')) throw new Error('SPA asset path is not rooted at /robots/assets/')
  const bundle = await fetch(new URL(scriptSrc, webUrl), { signal: AbortSignal.timeout(5_000) })
  if (!bundle.ok) throw new Error(`SPA bundle returned ${bundle.status}`)
  const bundleBytes = (await bundle.arrayBuffer()).byteLength
  if (bundleBytes < 1_000) throw new Error('SPA bundle is unexpectedly small')

  const { stdout } = await execFileAsync(
    '/usr/bin/ffprobe',
    [
      '-v', 'error', '-rtsp_transport', 'tcp', '-timeout', '8000000',
      '-read_intervals', '%+2', '-select_streams', 'v:0', '-count_packets',
      '-show_entries', 'stream=codec_name,width,height,nb_read_packets',
      '-of', 'json', rtspUrl,
    ],
    { timeout: 15_000, maxBuffer: 1_048_576 },
  )
  const stream = JSON.parse(stdout).streams?.[0]
  if (stream?.codec_name !== 'h264' || stream.width <= 0 || stream.height <= 0 || Number(stream.nb_read_packets) < 1)
    throw new Error('RTSP source returned no valid H.264 video packets')

  console.log(`[bench-health] deep ready: SPA ${bundleBytes} bytes; RTSP ${stream.width}x${stream.height}, ${stream.nb_read_packets} packets`)
}

try {
  if (sites.some((site) => !site.key)) throw new Error('demo API keys are missing')
  await Promise.all([8554, 9101, 9103, 9113, 30000, 30010].map(tcpReady))

  for (const site of sites) {
    const response = await fetch(`${base}/api/integration/v1/fleet`, {
      headers: { authorization: `Bearer ${site.key}` },
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error(`${site.id} fleet returned ${response.status}`)
    const data = await response.json()
    const robots = new Set((data.robots ?? []).map((item) => item.id))
    const telemetry = new Map((data.telemetry ?? []).map((item) => [item.id, item]))
    for (const id of site.robots) {
      if (!robots.has(id)) throw new Error(`${site.id} is missing ${id}`)
      if (telemetry.get(id)?.mode === 'offline') throw new Error(`${site.id} has offline robot ${id}`)
      if (!telemetry.has(id)) throw new Error(`${site.id} has no telemetry for ${id}`)
    }
  }
  if (process.argv.includes('--deep')) await deepReady()
} catch (error) {
  console.error(`[bench-health] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
