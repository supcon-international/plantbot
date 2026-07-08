export function utcClock(ts: number) {
  return new Date(ts).toISOString().slice(11, 19) + 'Z'
}

export function timeShort(ts: number) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
}

export function ago(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m ago`
  return `${Math.floor(h / 24)}d ago`
}

export function pct(v: number) {
  return `${Math.round(v)}%`
}
