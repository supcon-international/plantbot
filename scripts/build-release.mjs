#!/usr/bin/env node
// Build two offline deployment packages from committed sources only.
import { createHash } from 'node:crypto'
import {
  createReadStream,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'server/package.json')),
  YAML = require('yaml')
function run(command, args, cwd = root, capture = false) {
  const r = spawnSync(command, args, { cwd, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${command} failed (${r.status})${capture ? ': ' + r.stderr : ''}`)
  return capture ? r.stdout.trim() : ''
}
async function checksum(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
const platform = process.argv[2] ?? 'linux/amd64'
if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('Use linux/amd64 or linux/arm64')
if (run('git', ['status', '--porcelain', '--untracked-files=no'], root, true))
  throw new Error('Commit tracked changes before building a release')
const revision = run('git', ['rev-parse', 'HEAD'], root, true)
const version = JSON.parse(run('git', ['show', 'HEAD:package.json'], root, true)).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must be X.Y.Z')
const work = mkdtempSync(join(tmpdir(), 'plantbot-release-')),
  source = join(work, 'source'),
  output = join(root, 'dist/releases')
mkdirSync(output, { recursive: true })
try {
  mkdirSync(source)
  run('git', ['archive', '--format=tar', `--output=${join(work, 'source.tar')}`, revision])
  run('tar', ['-xf', join(work, 'source.tar'), '-C', source])
  const images = {}
  for (const service of ['api', 'relay', 'gateway', 'adapter', 'vision']) {
    const tag = `plantbot/${service}:${version}-${platform.split('/')[1]}`
    const file = ['adapter', 'vision'].includes(service)
      ? 'docker/adapter.Dockerfile'
      : 'docker/demo.Dockerfile'
    run(
      'docker',
      [
        'buildx',
        'build',
        '--platform',
        platform,
        '--file',
        file,
        ...(process.env.PB_NPM_REGISTRY
          ? ['--build-arg', `PB_NPM_REGISTRY=${process.env.PB_NPM_REGISTRY}`]
          : []),
        '--target',
        service,
        '--tag',
        tag,
        '--label',
        `org.opencontainers.image.version=${version}`,
        '--label',
        `org.opencontainers.image.revision=${revision}`,
        '--label',
        'org.opencontainers.image.source=https://github.com/supcon-international/plantbot',
        '--load',
        '.',
      ],
      source,
    )
    const [image] = JSON.parse(run('docker', ['image', 'inspect', tag], root, true))
    if (`${image.Os}/${image.Architecture}` !== platform) throw new Error(`Wrong architecture: ${tag}`)
    images[service] = { tag, id: image.Id }
  }
  for (const kind of ['server', 'adapter']) {
    const name = `plantbot-${kind}-v${version}-${platform.replace('/', '-')}`,
      bundle = join(work, name)
    mkdirSync(bundle)
    const compose = YAML.parse(readFileSync(join(source, `docker/release/compose.${kind}.yaml`), 'utf8'))
    const selected = {}
    for (const [service, config] of Object.entries(compose.services)) {
      config.image = images[service].tag
      config.platform = platform
      config.pull_policy = 'never'
      selected[service] = images[service]
    }
    writeFileSync(join(bundle, 'compose.yaml'), YAML.stringify(compose))
    cpSync(join(source, `docker/release/start-${kind}.sh`), join(bundle, 'start.sh'))
    cpSync(join(source, 'docs/release.md'), join(bundle, 'README.md'))
    cpSync(join(source, 'CHANGELOG.md'), join(bundle, 'CHANGELOG.md'))
    const files = ['images.tar', 'compose.yaml', 'start.sh', 'README.md', 'CHANGELOG.md', 'release.json']
    if (kind === 'adapter') {
      for (const [src, dest] of [
        ['integrations/adapter.example.json', 'adapter.example.json'],
        ['docs/vision.md', 'VISION.md'],
        ['integrations/vision/THIRD_PARTY.md', 'THIRD_PARTY.md'],
        ['integrations/vision/models.lock.json', 'models.lock.json'],
      ]) {
        cpSync(join(source, src), join(bundle, dest))
        files.push(dest)
      }
      cpSync(join(source, 'integrations/vision/licenses'), join(bundle, 'licenses'), { recursive: true })
      const { readdirSync } = await import('node:fs')
      for (const file of readdirSync(join(bundle, 'licenses'))) files.push(`licenses/${file}`)
    }
    writeFileSync(
      join(bundle, 'release.json'),
      JSON.stringify({ version, revision, component: kind, platform, images: selected }, null, 2) + '\n',
    )
    run('docker', [
      'image',
      'save',
      '--output',
      join(bundle, 'images.tar'),
      ...Object.values(selected).map((x) => x.tag),
    ])
    writeFileSync(
      join(bundle, 'SHA256SUMS'),
      (await Promise.all(files.map(async (f) => `${await checksum(join(bundle, f))}  ${f}`))).join('\n') +
        '\n',
    )
    const archive = `${name}.tar.gz`
    run('tar', ['-czf', join(output, archive), '-C', work, name])
    writeFileSync(join(output, `${archive}.sha256`), `${await checksum(join(output, archive))}  ${archive}\n`)
    console.log(`Release bundle: ${join(output, archive)}`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
