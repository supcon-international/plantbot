#!/usr/bin/env node
// Build Server, Adapter and Adapter Demo offline packages from committed sources only.
import { createHash } from 'node:crypto'
import {
  createReadStream,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  const demoPack = JSON.parse(readFileSync(join(source, 'integrations/demo/pack.json'), 'utf8'))
  const simulator = resolve(process.env.PLANTBOT_SIM_DIR ?? join(root, '../plantbotsimulator'))
  const simulatorSource = join(work, 'simulator')
  mkdirSync(simulatorSource)
  run('git', ['archive', '--format=tar', `--output=${join(work, 'simulator.tar')}`, demoPack.simulator.revision], simulator)
  run('tar', ['-xf', join(work, 'simulator.tar'), '-C', simulatorSource])
  const images = {}
  for (const service of ['api', 'relay', 'gateway', 'adapter', 'vision', 'demo-adapter', 'vision-demo']) {
    const tag = `plantbot/${service}:${version}-${platform.split('/')[1]}`
    const file = ['adapter', 'vision', 'vision-demo'].includes(service)
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
        ...(service === 'demo-adapter' ? ['--build-context', `simulator=${simulatorSource}`] : []),
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
        ...(service === 'demo-adapter' ? ['--label', `io.plantbot.simulator.revision=${demoPack.simulator.revision}`] : []),
        '--load',
        '.',
      ],
      source,
    )
    const [image] = JSON.parse(run('docker', ['image', 'inspect', tag], root, true))
    if (`${image.Os}/${image.Architecture}` !== platform) throw new Error(`Wrong architecture: ${tag}`)
    images[service] = { tag, id: image.Id }
  }
  for (const kind of ['server', 'adapter', 'adapter-demo']) {
    const name = `plantbot-${kind}-v${version}-${platform.replace('/', '-')}`,
      bundle = join(work, name)
    mkdirSync(bundle)
    const compose = YAML.parse(readFileSync(join(source, `docker/release/compose.${kind}.yaml`), 'utf8'))
    const selected = {}
    for (const [service, config] of Object.entries(compose.services)) {
      const imageName = kind === 'adapter-demo' && service === 'vision' ? 'vision-demo' : service === 'demo-seed' ? 'demo-adapter' : service
      config.image = images[imageName].tag
      config.platform = platform
      config.pull_policy = 'never'
      selected[imageName] = images[imageName]
    }
    writeFileSync(join(bundle, 'compose.yaml'), YAML.stringify(compose))
    writeFileSync(
      join(bundle, 'start.sh'),
      readFileSync(join(source, `docker/release/start-${kind}.sh`), 'utf8')
        .replaceAll('plantbot/api:VERSION', images.api.tag)
        .replaceAll('plantbot/demo-adapter:VERSION', images['demo-adapter'].tag),
      { mode: 0o755 },
    )
    cpSync(join(source, kind === 'adapter-demo' ? 'docs/demo.md' : 'docs/release.md'), join(bundle, 'README.md'))
    cpSync(join(source, 'CHANGELOG.md'), join(bundle, 'CHANGELOG.md'))
    const files = ['images.tar', 'compose.yaml', 'start.sh', 'README.md', 'CHANGELOG.md', 'release.json']
    if (kind === 'adapter' || kind === 'adapter-demo') {
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
      for (const file of readdirSync(join(bundle, 'licenses'))) files.push(`licenses/${file}`)
    }
    if (kind === 'adapter-demo') {
      cpSync(join(source, 'docker/release/demo.env.example'), join(bundle, '.env.demo.example'))
      cpSync(join(source, 'integrations/demo/pack.json'), join(bundle, 'demo.pack.json'))
      cpSync(join(source, 'integrations/demo/media'), join(bundle, 'media'), { recursive: true })
      cpSync(join(source, 'integrations/demo/THIRD_PARTY.md'), join(bundle, 'DEMO_SOURCES.md'))
      files.push('.env.demo.example', 'demo.pack.json', 'DEMO_SOURCES.md')
      for (const file of readdirSync(join(bundle, 'media'))) files.push(`media/${file}`)
    }
    writeFileSync(
      join(bundle, 'release.json'),
      JSON.stringify({ version, revision, component: kind, platform, images: selected,
        ...(kind === 'adapter-demo' ? { demoPack: demoPack.id, simulator: demoPack.simulator,
          media: JSON.parse(readFileSync(join(source, 'integrations/demo/media/manifest.json'), 'utf8')) } : {}) }, null, 2) + '\n',
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
