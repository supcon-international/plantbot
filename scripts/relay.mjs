#!/usr/bin/env node
/**
 * Dev media relay launcher. Starts the bundled go2rtc (fetched by
 * `pnpm run setup` into bin/) so RTSP playback works out of the box: the
 * platform registers rtsp:// sources with it (PUT /api/streams) and the web
 * player pulls fMP4-over-WebSocket (MSE) from :1984. `pnpm dev` points the
 * server's MEDIA_RELAY at http://127.0.0.1:1984.
 *
 * If the binary isn't present (setup not run, or unsupported platform) this
 * idles instead of exiting — under `concurrently -k`, exiting would tear down
 * the whole dev stack. The server's relayOnline probe stays false until go2rtc
 * answers, so the LIVE page shows RELAY OFFLINE rather than a black player.
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc')
const CONF = join(ROOT, 'bin', 'go2rtc.yaml')

function idle(msg) {
  console.log(msg)
  setInterval(() => {}, 1 << 30) // keep the process (and `concurrently -k`) alive
}

if (!existsSync(BIN)) {
  idle(
    '[relay] go2rtc not found in bin/ — run `pnpm run setup` to fetch it.\n' +
      '[relay] RTSP live playback stays offline until a relay is running; demo loops and snapshots are unaffected.',
  )
} else {
  // API-only config: we consume MSE over the :1984 WebSocket and add sources
  // via the REST API, so the RTSP/WebRTC listeners are just noise to silence.
  if (!existsSync(CONF))
    writeFileSync(CONF, 'log:\n  level: warn\napi:\n  listen: ":1984"\nrtsp:\n  listen: ""\nwebrtc:\n  listen: ""\n')

  let stopping = false
  let child
  const launch = () => {
    child = spawn(BIN, ['-config', CONF], { cwd: join(ROOT, 'bin'), stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('exit', (code) => {
      if (stopping) return
      console.log(`[relay] go2rtc exited (${code}) — restarting in 2s`)
      setTimeout(launch, 2000)
    })
  }
  console.log('[relay] starting go2rtc on :1984')
  launch()

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopping = true
      child?.kill('SIGTERM')
      setTimeout(() => process.exit(0), 200)
    })
  }
}
