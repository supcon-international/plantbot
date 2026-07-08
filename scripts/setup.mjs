#!/usr/bin/env node
/**
 * One-shot asset bootstrap. Downloads every external resource the app needs:
 *  - go2rtc binary (RTSP → MSE/WebRTC relay)          → server/bin/
 *  - Mixkit stock footage (free license, loops)        → server/media/
 *  - DeepRobotics Lite3/X30 URDF + STL meshes          → web/public/assets/robots/
 *  - INRIA 3DGS "train" splat (via huggingface),
 *    cropped to the yard corridor                      → web/public/assets/scenes/
 * Everything is skipped if already present. No dependencies.
 */
import { mkdirSync, existsSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GO2RTC_VERSION = 'v1.9.14'

async function fetchBuf(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function download(url, dest, label) {
  if (existsSync(dest) && statSync(dest).size > 1000) {
    console.log(`  ✓ ${label} (cached)`)
    return
  }
  mkdirSync(dirname(dest), { recursive: true })
  process.stdout.write(`  ↓ ${label} … `)
  writeFileSync(dest, await fetchBuf(url))
  console.log('done')
}

// ---------- go2rtc ----------
async function go2rtc() {
  const bin = join(ROOT, 'server', 'bin', 'go2rtc')
  if (existsSync(bin)) return console.log('  ✓ go2rtc (cached)')
  const plat = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const zip = join(ROOT, 'server', 'bin', 'go2rtc.zip')
  await download(
    `https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/go2rtc_${plat}_${arch}.zip`,
    zip,
    `go2rtc ${GO2RTC_VERSION} (${plat}/${arch})`,
  )
  execSync(`unzip -o go2rtc.zip && rm go2rtc.zip`, { cwd: join(ROOT, 'server', 'bin') })
  chmodSync(bin, 0o755)
  console.log('  ✓ go2rtc unpacked')
}

// ---------- footage (Mixkit free license) ----------
const FOOTAGE = {
  'switchgear.mp4': 'https://assets.mixkit.co/videos/23377/23377-720.mp4',
  'worker.mp4': 'https://assets.mixkit.co/videos/23378/23378-720.mp4',
  'workshop.mp4': 'https://assets.mixkit.co/videos/22032/22032-720.mp4',
  'plant_aerial.mp4': 'https://assets.mixkit.co/videos/14631/14631-720.mp4',
  'smokestack.mp4': 'https://assets.mixkit.co/videos/14051/14051-720.mp4',
  'pumpjack.mp4': 'https://assets.mixkit.co/videos/48884/48884-360.mp4', // OGI channel source
}

// ---------- robots (DeepRobotics official models + Clearpath Husky) ----------
const DR = 'https://cdn.jsdelivr.net/gh/DeepRoboticsLab/deep_robotics_model@main'
const ROBOT_FILES = {}
for (const [dir, name] of [
  ['lite3', 'Lite3'],
  ['x30', 'X30'],
]) {
  ROBOT_FILES[`${dir}/${name}.urdf`] = `${DR}/${name}/urdf/${name}.urdf`
  for (const m of ['torso', 'hip', 'thigh', 'shank'])
    ROBOT_FILES[`${dir}/meshes/${m}.STL`] = `${DR}/${name}/urdf/meshes/${m}.STL`
}
// Husky meshes from the official repo; the flattened URDF itself lives in-repo
const HUSKY = 'https://raw.githubusercontent.com/husky/husky/humble-devel/husky_description/meshes'
for (const m of ['base_link', 'top_chassis', 'wheel', 'top_plate', 'user_rail'])
  ROBOT_FILES[`husky/meshes/${m}.stl`] = `${HUSKY}/${m}.stl`

// ---------- gaussian splat scene ----------
function cropSplat(buf) {
  // keep the train + track corridor, drop sky/background/floaters
  const theta = 0.562
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const [cx, cz] = [0.11, 0.15]
  const n = Math.floor(buf.length / 32)
  const out = []
  for (let i = 0; i < n; i++) {
    const off = i * 32
    const x = buf.readFloatLE(off)
    const y = buf.readFloatLE(off + 4)
    const z = buf.readFloatLE(off + 8)
    const dx = x - cx
    const dz = z - cz
    const u = c * dx + s * dz
    const v = -s * dx + c * dz
    if (!(Math.abs(u) < 8.6 && v > -2.2 && v < 2.0 && y < 0.92)) continue
    const ceiling = u > -6.5 && u < 7.5 ? -1.72 : -1.15
    if (y < ceiling) continue
    const smax = Math.max(buf.readFloatLE(off + 12), buf.readFloatLE(off + 16), buf.readFloatLE(off + 20))
    let limit
    if (y < -1.15) limit = Math.abs(v) < 1.3 ? 0.045 : 0.03
    else limit = Math.abs(v) < 1.85 && Math.abs(u) < 7.5 ? 0.3 : 0.06
    if (smax > limit) continue
    out.push(buf.subarray(off, off + 32))
  }
  return Buffer.concat(out)
}

async function splatScene() {
  const dest = join(ROOT, 'web', 'public', 'assets', 'scenes', 'train_yard.splat')
  if (existsSync(dest) && statSync(dest).size > 1e6) return console.log('  ✓ train_yard.splat (cached)')
  mkdirSync(dirname(dest), { recursive: true })
  process.stdout.write('  ↓ INRIA 3DGS "train" scene (33 MB) … ')
  const raw = await fetchBuf('https://huggingface.co/cakewalk/splat-data/resolve/main/train.splat')
  console.log('done')
  process.stdout.write('  ✂ cropping to yard corridor … ')
  writeFileSync(dest, cropSplat(raw))
  console.log(`done (${(statSync(dest).size / 1e6).toFixed(1)} MB)`)
}

console.log('[1/4] go2rtc relay')
await go2rtc()

console.log('[2/4] camera footage (Mixkit free license)')
for (const [name, url] of Object.entries(FOOTAGE))
  await download(url, join(ROOT, 'server', 'media', name), name)

console.log('[3/4] DeepRobotics URDF models (DeepRoboticsLab/deep_robotics_model)')
for (const [rel, url] of Object.entries(ROBOT_FILES))
  await download(url, join(ROOT, 'web', 'public', 'assets', 'robots', rel), rel)

console.log('[4/4] gaussian splat scene (huggingface cakewalk/splat-data)')
await splatScene()

console.log('\nAll assets ready. Run: pnpm dev')
