#!/usr/bin/env node
/**
 * One-shot asset bootstrap. Downloads every external resource the app needs:
 *  - go2rtc binary (RTSP → MSE/WebRTC relay)          → server/bin/
 *  - Mixkit stock footage (free license, loops)        → server/media/
 *  - DeepRobotics Lite3/X30 URDF + STL meshes          → web/public/assets/robots/
 *  - tandt "truck" 3DGS splat (via huggingface),
 *    cropped to an open yard footprint                 → web/public/assets/scenes/
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
  'substation.mp4': 'https://assets.mixkit.co/videos/23107/23107-720.mp4',
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
  // open-yard footprint around the truck; drop sky, far shell and floaters
  const theta = 0.705
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const [cx, cz] = [0.9, 0.62]
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
    if (!(Math.abs(u) < 13.5 && Math.abs(v) < 7.2 && y > -4.3 && y < 1.12)) continue
    const smax = Math.max(buf.readFloatLE(off + 12), buf.readFloatLE(off + 16), buf.readFloatLE(off + 20))
    // blown-out white blobs (overexposed foliage)
    if (buf[off + 24] > 225 && buf[off + 25] > 225 && buf[off + 26] > 225 && smax > 0.09) continue
    let limit
    if (y < -2.2) limit = 0.2
    else limit = Math.abs(v) < 5.5 && Math.abs(u) < 11 ? 0.42 : 0.09
    if (smax > limit) continue
    out.push(buf.subarray(off, off + 32))
  }
  return Buffer.concat(out)
}

async function splatScene() {
  const dest = join(ROOT, 'web', 'public', 'assets', 'scenes', 'truck_yard.splat')
  if (existsSync(dest) && statSync(dest).size > 1e6) return console.log('  ✓ truck_yard.splat (cached)')
  mkdirSync(dirname(dest), { recursive: true })
  process.stdout.write('  ↓ tandt 3DGS "truck" scene (81 MB) … ')
  const raw = await fetchBuf('https://huggingface.co/cakewalk/splat-data/resolve/main/truck.splat')
  console.log('done')
  process.stdout.write('  ✂ cropping to yard corridor … ')
  writeFileSync(dest, cropSplat(raw))
  console.log(`done (${(statSync(dest).size / 1e6).toFixed(1)} MB)`)
}

console.log('[1/4] go2rtc relay')
await go2rtc()

// Mixkit clips ship with long GOPs; re-encode to keyint 15 so stream
// switching starts in <1 s. Requires ffmpeg (the relay needs it anyway).
const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg'
async function footage(name, url) {
  const dest = join(ROOT, 'server', 'media', name)
  if (existsSync(dest) && statSync(dest).size > 1e5) return console.log(`  ✓ ${name} (cached)`)
  const tmp = `${dest}.dl`
  await download(url, tmp, name)
  execSync(
    `"${FFMPEG}" -y -loglevel error -i "${tmp}" -c:v libx264 -crf 20 -preset medium -g 15 -keyint_min 15 -pix_fmt yuv420p -an "${dest}" && rm "${tmp}"`,
  )
  console.log(`  ✓ ${name} transcoded (GOP 15)`)
}

async function stagingFeed() {
  const dest = join(ROOT, 'server', 'media', 'staging.mp4')
  if (existsSync(dest) && statSync(dest).size > 1e5) return console.log('  ✓ staging.mp4 (cached)')
  const webm = `${dest}.webm`
  await download(
    'https://upload.wikimedia.org/wikipedia/commons/5/52/Spot_construction_robot.webm',
    webm,
    'Spot staging footage (Wikimedia Commons CC)',
  )
  // boomerang (forward + reversed) so the short clip loops seamlessly
  execSync(
    `"${FFMPEG}" -y -loglevel error -i "${webm}" -filter_complex "[0:v]scale=1280:-2,split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[out]" -map "[out]" -c:v libx264 -crf 20 -preset medium -g 15 -pix_fmt yuv420p -an "${dest}" && rm "${webm}"`,
  )
  console.log('  ✓ staging.mp4 transcoded (seamless loop)')
}

/** Pre-render the thermal / OGI looks once — playback stays native & smooth. */
async function filteredFeed(name, srcName, vf) {
  const dest = join(ROOT, 'server', 'media', name)
  if (existsSync(dest) && statSync(dest).size > 1e5) return console.log(`  ✓ ${name} (cached)`)
  const src = join(ROOT, 'server', 'media', srcName)
  process.stdout.write(`  ⚙ rendering ${name} … `)
  execSync(
    `"${FFMPEG}" -y -loglevel error -i "${src}" -vf "${vf}" -r 25 -c:v libx264 -crf 20 -preset medium -g 15 -pix_fmt yuv420p -an "${dest}"`,
  )
  console.log('done')
}

console.log('[2/4] camera footage (Mixkit free license + Commons)')
for (const [name, url] of Object.entries(FOOTAGE)) await footage(name, url)
await stagingFeed()
await filteredFeed('thermal.mp4', 'smokestack.mp4', 'format=gray,format=gbrp,pseudocolor=preset=inferno,scale=960:-2')
await filteredFeed('ogi.mp4', 'pumpjack.mp4', 'format=gray,eq=contrast=1.55:brightness=-0.06,unsharp=5:5:0.8,noise=alls=5:allf=t,scale=960:-2')

console.log('[3/4] DeepRobotics URDF models (DeepRoboticsLab/deep_robotics_model)')
for (const [rel, url] of Object.entries(ROBOT_FILES))
  await download(url, join(ROOT, 'web', 'public', 'assets', 'robots', rel), rel)

console.log('[4/4] gaussian splat scene (huggingface cakewalk/splat-data)')
await splatScene()

console.log('\nAll assets ready. Run: pnpm dev')
