#!/usr/bin/env node
// Build from committed files only; never package local data, credentials or dependencies.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'server/package.json'))
const YAML = require('yaml')
function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, { cwd, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})${capture ? `: ${result.stderr}` : ''}`)
  return capture ? result.stdout.trim() : ''
}
async function checksum(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
const platform = process.argv[2] ?? 'linux/amd64'
if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('Use linux/amd64 or linux/arm64')
if (run('git', ['status', '--porcelain', '--untracked-files=no'], root, true)) throw new Error('Commit tracked changes before building a release')
const revision = run('git', ['rev-parse', 'HEAD'], root, true)
const version = JSON.parse(run('git', ['show', 'HEAD:package.json'], root, true)).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must be X.Y.Z')
const simDir = resolve(process.env.PLANTBOT_SIM_DIR ?? join(root, '../plantbotsimulator'))
const simRef = process.env.PLANTBOT_SIM_REF ?? 'dc32eea659b846c250d981b4146002733e6763f2'
const simulatorRevision = run('git', ['rev-parse', `${simRef}^{commit}`], simDir, true)
const work = mkdtempSync(join(tmpdir(), 'plantbot-release-'))
const source = join(work, 'source'), simulator = join(work, 'simulator')
const name = `plantbot-v${version}-${platform.replace('/', '-')}`
const bundle = join(work, name)
const output = join(root, 'dist/releases')
mkdirSync(output, { recursive: true })
try {
  for (const [repo, ref, dest, archive] of [[root, revision, source, 'source.tar'], [simDir, simulatorRevision, simulator, 'simulator.tar']]) {
    mkdirSync(dest)
    run('git', ['archive', '--format=tar', `--output=${join(work, archive)}`, ref], repo)
    run('tar', ['-xf', join(work, archive), '-C', dest])
  }
  const services = ['api', 'bench', 'relay', 'gateway']
  const images = {}
  for (const service of services) {
    const tag = `plantbot/${service}:${version}-${platform.split('/')[1]}`
    run('docker', ['buildx', 'build', '--platform', platform, '--file', 'docker/demo.Dockerfile',
      '--build-context', `simulator=${simulator}`, '--target', service, '--tag', tag,
      '--label', `org.opencontainers.image.version=${version}`, '--label', `org.opencontainers.image.revision=${revision}`,
      '--label', 'org.opencontainers.image.source=https://github.com/supcon-international/plantbot', '--load', '.'], source)
    const [image] = JSON.parse(run('docker', ['image', 'inspect', tag], root, true))
    if (`${image.Os}/${image.Architecture}` !== platform) throw new Error(`Wrong architecture: ${tag}`)
    images[service] = { tag, id: image.Id }
  }
  mkdirSync(join(bundle, 'scripts'), { recursive: true })
  const compose = YAML.parse(readFileSync(join(source, 'compose.demo.yaml'), 'utf8'))
  delete compose['x-plantbot-build']
  for (const [service, config] of Object.entries(compose.services)) {
    delete config.build
    config.image = images[service].tag
    config.platform = platform
    config.pull_policy = 'never'
  }
  writeFileSync(join(bundle, 'compose.release.yaml'), YAML.stringify(compose))
  cpSync(join(source, 'scripts/demo-up.sh'), join(bundle, 'scripts/demo-up.sh'))
  cpSync(join(source, 'scripts/release-start.sh'), join(bundle, 'start.sh'))
  cpSync(join(source, 'docs/release.md'), join(bundle, 'README.md'))
  cpSync(join(source, 'CHANGELOG.md'), join(bundle, 'CHANGELOG.md'))
  writeFileSync(join(bundle, 'release.json'), JSON.stringify({ version, revision, simulatorRevision, platform, images }, null, 2) + '\n')
  run('docker', ['image', 'save', '--output', join(bundle, 'images.tar'), ...Object.values(images).map(x => x.tag)])
  const files = ['images.tar', 'compose.release.yaml', 'scripts/demo-up.sh', 'start.sh', 'README.md', 'CHANGELOG.md', 'release.json']
  const hashes = await Promise.all(files.map(async file => `${await checksum(join(bundle, file))}  ${file}`))
  writeFileSync(join(bundle, 'SHA256SUMS'), hashes.join('\n') + '\n')
  const archive = `${name}.tar.gz`
  run('tar', ['-czf', join(output, archive), '-C', work, name])
  writeFileSync(join(output, `${archive}.sha256`), `${await checksum(join(output, archive))}  ${archive}\n`)
  console.log(`Release bundle: ${join(output, archive)}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
