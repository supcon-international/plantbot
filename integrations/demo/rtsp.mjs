#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const streams = { instrument: 'instrument', 'restricted-area': 'restricted-area', 'gs-f2-01-front': 'restricted-area', 'gs-f2-01-rear': 'restricted-area', 'gs-f2-01-thermal': 'instrument' }
writeFileSync('/tmp/demo-rtsp.yaml', `log:\n  level: warn\nffmpeg:\n  file: "-re -stream_loop -1 -i {input}"\nrtsp:\n  listen: ":8554"\nwebrtc:\n  listen: ""\napi:\n  listen: ""\nstreams:\n${Object.entries(streams).map(([name,file]) => `  ${JSON.stringify(name)}: ${JSON.stringify(`ffmpeg:/opt/plantbot-demo/media/${file}.mp4#video=copy`)}`).join('\n')}\n`)
const child = spawn('/app/robots/bin/go2rtc', ['-config', '/tmp/demo-rtsp.yaml'], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.once('exit', code => { process.exitCode = code ?? 0 })
