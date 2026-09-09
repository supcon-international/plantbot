import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installDemoMedia } from './demo-media.mjs'

test('replaces old large cached footage, verifies reuse, and refuses corrupt sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-media-cache-'))
  try {
    const source = join(root, 'source'), target = join(root, 'target')
    mkdirSync(source); mkdirSync(target)
    const real = Buffer.from('verified recorded video fixture')
    const original = Buffer.alloc(150001, 1)
    writeFileSync(join(source, 'recorded.mp4'), real)
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({
      files: { 'recorded.mp4': createHash('sha256').update(real).digest('hex') },
      platformFiles: { 'switchgear.mp4': 'recorded.mp4' },
      retiredPlatformFiles: ['ogi.mp4'],
    }))
    writeFileSync(join(target, 'switchgear.mp4'), original)
    writeFileSync(join(target, 'ogi.mp4'), original)
    const updated = installDemoMedia(source, target, () => {})
    assert.deepEqual(updated.copied, ['switchgear.mp4'])
    assert.deepEqual(updated.removed, ['ogi.mp4'])
    assert.deepEqual(readFileSync(join(target, 'switchgear.mp4')), real)
    assert.deepEqual(installDemoMedia(source, target, () => {}).cached, ['switchgear.mp4'])
    writeFileSync(join(target, 'switchgear.mp4'), original)
    writeFileSync(join(source, 'recorded.mp4'), 'corrupt')
    assert.throws(() => installDemoMedia(source, target, () => {}), /checksum mismatch/)
    assert.deepEqual(readFileSync(join(target, 'switchgear.mp4')), original)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
