export function utcClock(ts: number) {
  return new Date(ts).toISOString().slice(11, 19) + 'Z'
}

export function timeShort(ts: number) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
}
