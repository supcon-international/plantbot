#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../server/package.json', import.meta.url))
const { WebSocket } = require('ws')

const base = (process.env.PB_DEMO_SMOKE_BASE ?? 'http://gateway:8080/robots').replace(/\/$/, '')
const wsBase = base.replace(/^http/, 'ws')
const FETCH_TIMEOUT_MS = 10_000

function timedFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

async function responseJson(response, label) {
  assert.equal(response.ok, true, `${label} returned ${response.status}`)
  return response.json()
}

function expectUnauthorizedSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('anonymous playback socket did not reject in time'))
    }, 5_000)
    socket.once('open', () => {
      clearTimeout(timer)
      socket.terminate()
      reject(new Error('anonymous playback socket was accepted'))
    })
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      response.resume()
      if (response.statusCode === 401) resolve()
      else reject(new Error(`anonymous playback returned ${response.statusCode}`))
    })
    socket.once('error', () => {})
  })
}

function expectMseMedia(url, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Cookie: cookie } })
    let negotiated = false
    let mediaBytes = 0
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('authenticated MSE stream did not deliver media in time'))
    }, 15_000)
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      response.resume()
      reject(new Error(`authenticated playback returned ${response.statusCode}`))
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.once('open', () => {
      // Same MSE capability request sent by the browser's VideoRTC element.
      socket.send(JSON.stringify({ type: 'mse', value: 'avc1.640029,avc1.64002A,avc1.640033' }))
    })
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!negotiated) return
        mediaBytes += data.byteLength
        if (mediaBytes < 8_192) return
        clearTimeout(timer)
        socket.terminate()
        resolve()
        return
      }
      let message
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }
      if (message.type !== 'mse') return
      negotiated = true
    })
  })
}

let session
let cookie
try {
  const htmlResponse = await timedFetch(`${base}/`)
  assert.equal(htmlResponse.status, 200)
  assert.match(await htmlResponse.text(), /id=["']root["']/)

  assert.equal((await timedFetch(`${base}/api/sites`)).status, 401)

  const login = await timedFetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', password: process.env.PB_VIEWER_PASSWORD }),
  })
  assert.equal(login.status, 200)
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie, 'login did not issue a session cookie')

  const { channels } = await responseJson(
    await timedFetch(`${base}/api/sites/campus-east/channels`, { headers: { Cookie: cookie } }),
    'campus channels',
  )
  const channel = channels.find((item) => item.id.endsWith(':x30ce-therm'))
  assert.ok(channel, 'campus-east X30 thermal channel is missing')
  assert.equal(channel.source?.kind, 'rtsp', 'campus-east X30 thermal channel is not RTSP')

  const opened = await responseJson(
    await timedFetch(`${base}/api/sites/campus-east/channels/${encodeURIComponent(channel.id)}/sessions`, {
      method: 'POST',
      headers: { Cookie: cookie },
    }),
    'stream session',
  )
  session = opened.session
  assert.equal(session.protocol, 'mse')
  assert.equal(session.relayOnline, true)

  const playbackUrl = `${wsBase}/stream/api/ws?src=${encodeURIComponent(session.url)}`
  await expectUnauthorizedSocket(playbackUrl)
  await expectMseMedia(playbackUrl, cookie)
  console.log('[demo-smoke] SPA, auth gate and RTSP -> MSE media delivery: pass')
} finally {
  if (cookie && session?.id) {
    await timedFetch(`${base}/api/sites/campus-east/stream-sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    }).catch(() => {})
  }
}

// `ws`/undici may retain an idle keep-alive handle after the assertions. This
// is a one-shot deployment probe, so exit explicitly once cleanup has run.
process.exit(0)
