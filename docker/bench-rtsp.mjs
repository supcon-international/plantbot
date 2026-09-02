#!/usr/bin/env node

// Docker-only RTSP origin for the simulator bench. The built-in adapter demo
// profiles name MP4 files; exposing the same names over RTSP lets one env var
// (STREAM_BASE=rtsp://bench:8554) exercise the real RTSP -> relay -> MSE path.

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.PLANTBOT_ROOT ?? '/app/robots'
const BIN = process.env.GO2RTC_BIN ?? join(ROOT, 'bin', 'go2rtc')
const MEDIA = process.env.SIM_RTSP_MEDIA_DIR ?? join(ROOT, 'server', 'media')
const PORT = process.env.SIM_RTSP_PORT ?? '8554'
const CONF = '/tmp/go2rtc.sim.yaml'

const streams = {
  // Names used directly by the bundled Spot/X30/GS adapter profiles.
  'switchgear.mp4': 'switchgear.mp4',
  'thermal.mp4': 'thermal.mp4',
  'campus_gate.mp4': 'campus_gate.mp4',
  'night_walkway.mp4': 'night_walkway.mp4',
  'substation.mp4': 'substation.mp4',
  'campus_quad.mp4': 'campus_quad.mp4',
  'theft_cctv.mp4': 'theft_cctv.mp4',
  'campus_walk.mp4': 'campus_walk.mp4',
  // Vendor-cloud camera names returned by the GS simulator.
  'gs-f2-01-front': 'campus_quad.mp4',
  'gs-f2-01-thermal': 'thermal.mp4',
  'gs-f2-01-rear': 'theft_cctv.mp4',
  'gs-f2-02-front': 'campus_walk.mp4',
  'gs-f2-02-rear': 'night_walkway.mp4',
  'spot-ce-front': 'campus_gate.mp4',
  'x30-ce-front': 'night_walkway.mp4',
}

if (!existsSync(BIN)) {
  console.error(`[rtsp] go2rtc missing at ${BIN}`)
  process.exit(1)
}

for (const file of new Set(Object.values(streams))) {
  if (!existsSync(join(MEDIA, file))) {
    console.error(`[rtsp] demo media missing: ${join(MEDIA, file)}`)
    process.exit(1)
  }
}

const streamYaml = Object.entries(streams)
  // setup.mjs already normalizes every clip to H.264/yuv420p with a short GOP.
  // Copy that bitstream instead of starting one libx264 encoder per open tile.
  .map(([name, file]) => `  ${JSON.stringify(name)}: ${JSON.stringify(`ffmpeg:${join(MEDIA, file)}#video=copy`)}`)
  .join('\n')

writeFileSync(
  CONF,
  `log:\n  level: warn\nffmpeg:\n  file: "-re -stream_loop -1 -i {input}"\nrtsp:\n  listen: ":${PORT}"\nwebrtc:\n  listen: ""\napi:\n  listen: ""\nstreams:\n${streamYaml}\n`,
)

console.log(`[rtsp] Docker simulator origin ready on :${PORT} (${Object.keys(streams).length} streams)`)
const child = spawn(BIN, ['-config', CONF], { stdio: 'inherit' })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
