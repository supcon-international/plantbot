// Shared HTTP client used by every node — the JS mirror of
// @plantbot/adapter-sdk's PlantbotClient. Same contract: never throws on
// transport errors (adapters must outlive platform restarts), every call
// resolves null on failure.
'use strict'

class PlantbotClient {
  constructor(base, key) {
    this.base = String(base || 'http://127.0.0.1:8787').replace(/\/$/, '')
    this.key = key || ''
  }

  async call(method, path, body) {
    try {
      const res = await fetch(`${this.base}/api/integration/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 200) }
      return { ok: true, data: await res.json() }
    } catch (e) {
      return { ok: false, status: 0, error: e.message }
    }
  }

  site() {
    return this.call('GET', '/site')
  }
  register(fs) {
    return this.call('POST', '/robots', fs)
  }
  state(serial, s) {
    return this.call('POST', `/robots/${encodeURIComponent(serial)}/state`, s)
  }
  pullOrders(serial) {
    return this.call('GET', `/robots/${encodeURIComponent(serial)}/orders`)
  }
  orderStatus(id, status, note) {
    return this.call('POST', `/orders/${encodeURIComponent(id)}/status`, { status, note })
  }
  event(ev) {
    return this.call('POST', '/events', ev)
  }
  readings(serial, items) {
    return this.call('POST', `/robots/${encodeURIComponent(serial)}/readings`, { readings: items })
  }
  snapshot(stream) {
    return this.call('POST', '/snapshot', { stream })
  }
}

module.exports = { PlantbotClient }
