import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'plantbot-media-'))
const pub = process.env.PUBLIC_BASE ?? '/robots'
process.env.PUBLIC_BASE = pub
process.env.PB_DATA_DIR = dir
process.env.MEDIA_RELAY = ''
const { filePlaybackUrl } = await import('../../../server/src/media.js')
const { World } = await import('../../../server/src/world.js')
const { db } = await import('../../../server/src/db.js')
const media = fileURLToPath(new URL('../../../server/media/', import.meta.url))
mkdirSync(media, { recursive: true })
const filename = `qa-playback-${randomUUID()}.mp4`
const file = join(media, filename)
// A unique, exclusively created metadata fixture: never replace bundled footage.
writeFileSync(file, 'first-recording', { flag: 'wx' })
const source = `${pub}/media/${filename}`

after(() => {
  db.close()
  rmSync(file, { force: true })
  rmSync(dir, { recursive: true, force: true })
})

test('file playback preserves the public prefix, query, and fragment with one stable version', () => {
  const result = filePlaybackUrl(`${source}?download=1&v=obsolete#t=2`)
  const url = new URL(result, 'http://localhost')
  assert.equal(url.pathname, source)
  assert.equal(url.searchParams.get('download'), '1')
  assert.equal(url.hash, '#t=2')
  assert.equal(url.searchParams.getAll('v').length, 1)
  assert.match(url.searchParams.get('v')!, /^\d+-\d+$/)
  assert.notEqual(url.searchParams.get('v'), 'obsolete')
  assert.equal(filePlaybackUrl(result), result)
})

test('rewriting the same media filename invalidates both equal-size and changed-size content', () => {
  const before = filePlaybackUrl(source)
  const previous = statSync(file)
  writeFileSync(file, 'other-recording')
  assert.equal(statSync(file).size, previous.size)
  // Filesystem timestamp granularity varies; set an explicit later modification time.
  const later = new Date(previous.mtimeMs + 2000)
  utimesSync(file, later, later)
  const rewritten = filePlaybackUrl(source)
  assert.notEqual(rewritten, before)
  writeFileSync(file, 'a-longer-new-recording')
  assert.notEqual(filePlaybackUrl(source), rewritten)
})

test('unavailable, external, and nonlocal sources are returned unchanged', () => {
  for (const value of [
    `${pub}/media/not-present-${randomUUID()}.mp4`,
    `https://camera.example/media/${filename}?token=opaque`,
    'rtsp://camera.example/live',
    `${pub}/assets/${filename}`,
    `${pub}/media/../${filename}`,
    `${pub}/media/%2e%2e/${filename}`,
    `${pub}/media/file.webm`,
  ]) assert.equal(filePlaybackUrl(value), value)
})

test('browser channels and leases are versioned without changing recording or snapshot sources', async () => {
  const camera = { id: 'recorded', name: 'Recorded fixture', place: 'Test bench', live: true, source: 'fixed', stream: 'recorded-stream', file: source }
  const world = new World({ id: 'media-qa', name: 'Media QA', operator: 'test', bounds: { x: [0, 10], z: [0, 10] }, map: null,
    dockWp: '', buildings: [], waypoints: [], zones: [], cameras: [camera], transforms: [] })
  const original = structuredClone(world.channels())
  const publicSource = world.publicChannels()[0].source
  assert.deepEqual(publicSource, { kind: 'file', file: filePlaybackUrl(source) })
  const session = await world.openSession('cam:recorded')
  assert.equal(session?.url, filePlaybackUrl(source))
  assert.equal(session?.protocol, 'file')
  assert.equal(session?.expiresAt, null)
  assert.deepEqual(world.channels(), original, 'The recording path consumes raw channels, never browser cache parameters')
  assert.deepEqual(world.frameSource('recorded-stream'), { kind: 'file', file: filename })
  assert.equal(camera.file, source)
  world.cameras.push({ id: 'rtsp', name: 'Native RTSP fixture', place: 'Test bench', live: true, source: 'fixed', stream: 'native-stream', rtsp: 'rtsp://user:secret@camera.example/live' })
  assert.deepEqual(world.publicChannels()[1].source, { kind: 'rtsp', url: '' })
  assert.deepEqual(world.frameSource('native-stream'), { kind: 'rtsp', url: 'rtsp://user:secret@camera.example/live' })
})
