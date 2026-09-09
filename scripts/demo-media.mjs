// Install the reviewed, recorded clips shipped with the repository. A stale
// filename is never a cache hit: both source and installed bytes are verified.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const videoName = name => typeof name === 'string' && /^[a-z0-9][a-z0-9._-]*\.mp4$/.test(name)

export function installDemoMedia(sourceDir, targetDir, report = console.log) {
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'))
  const mappings = Object.entries(manifest.platformFiles ?? {})
  if (!mappings.length) throw new Error('Recorded media manifest has no platform files')
  const retired = manifest.retiredPlatformFiles ?? []
  if (!Array.isArray(retired) || retired.some(name => !videoName(name) || manifest.platformFiles[name]))
    throw new Error('Invalid retired demo media filename')
  for (const [destination, source] of mappings) {
    if (!videoName(destination) || !videoName(source)) throw new Error('Invalid recorded media filename')
    const expected = manifest.files?.[source]
    if (!/^[a-f0-9]{64}$/.test(expected ?? '') || digest(join(sourceDir, source)) !== expected)
      throw new Error(`Recorded source checksum mismatch: ${source}`)
  }
  mkdirSync(targetDir, { recursive: true })
  const result = { copied: [], cached: [], removed: [] }
  for (const [destination, source] of mappings) {
    const target = join(targetDir, destination), expected = manifest.files[source]
    if (existsSync(target) && digest(target) === expected) {
      result.cached.push(destination)
      report(`  ✓ ${destination} (recorded footage, verified)`)
      continue
    }
    const temporary = `${target}.${process.pid}.tmp`
    try {
      copyFileSync(join(sourceDir, source), temporary)
      if (digest(temporary) !== expected) throw new Error(`Copied media checksum mismatch: ${destination}`)
      renameSync(temporary, target)
    } finally { rmSync(temporary, { force: true }) }
    result.copied.push(destination)
    report(`  ✓ ${destination} replaced with verified recorded footage`)
  }
  for (const name of retired) {
    if (!existsSync(join(targetDir, name))) continue
    rmSync(join(targetDir, name))
    result.removed.push(name)
    report(`  ✓ retired simulated footage removed: ${name}`)
  }
  return result
}
