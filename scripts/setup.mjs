#!/usr/bin/env node
/**
 * One-shot asset bootstrap. Downloads every external resource the app needs:
 *  - Mixkit stock footage (free license) + Wikimedia Spot clip → server/media/
 *  - URDF twins: DeepRobotics X30 (official model repo) and Boston Dynamics
 *    Spot (RAI Institute spot_description visual meshes, MIT; the flattened
 *    spot.urdf lives in-repo) — GS F2 renders as a silhouette
 *                                                      → web/public/assets/robots/
 * Everything is skipped if already present.
 * Host requirements: node ≥ 22.22, ffmpeg on PATH.
 *   (unzip is used to unpack the go2rtc mac/win zip; present by default.)
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FETCH_TIMEOUT_MS = Number(process.env.PB_SETUP_FETCH_TIMEOUT_MS ?? 0)
if (!Number.isFinite(FETCH_TIMEOUT_MS) || FETCH_TIMEOUT_MS < 0)
  throw new Error('PB_SETUP_FETCH_TIMEOUT_MS must be a non-negative number')

async function fetchBuf(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    ...(FETCH_TIMEOUT_MS > 0 ? { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) } : {}),
  })
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
  // GitHub raw / CDNs rate-limit bursts — retry with a pause before failing
  for (let attempt = 1; ; attempt++) {
    try {
      writeFileSync(dest, await fetchBuf(url))
      break
    } catch (e) {
      if (attempt >= 3) throw e
      process.stdout.write(`retry ${attempt} … `)
      await new Promise((r) => setTimeout(r, 2500 * attempt))
    }
  }
  console.log('done')
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function sha256File(path) {
  return sha256(readFileSync(path))
}

async function downloadVerified(url, dest, label, expectedSha256) {
  if (existsSync(dest)) {
    if (sha256File(dest) === expectedSha256) {
      console.log(`  ✓ ${label} (cached, verified)`)
      return
    }
    unlinkSync(dest)
    console.log(`  ! ${label} cache checksum mismatch; downloading again`)
  }

  mkdirSync(dirname(dest), { recursive: true })
  process.stdout.write(`  ↓ ${label} … `)
  for (let attempt = 1; ; attempt++) {
    try {
      const body = await fetchBuf(url)
      const actualSha256 = sha256(body)
      if (actualSha256 !== expectedSha256)
        throw new Error(`SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}`)
      writeFileSync(dest, body)
      break
    } catch (e) {
      if (attempt >= 3) throw e
      process.stdout.write(`retry ${attempt} … `)
      await new Promise((r) => setTimeout(r, 2500 * attempt))
    }
  }
  console.log('done (verified)')
}

// ---------- host prerequisites ----------
function preflight() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' })
  } catch {
    console.error('✗ ffmpeg not found on PATH — install it (macOS: brew install ffmpeg) and rerun.')
    process.exit(1)
  }
}
preflight()

// ---------- footage (Mixkit free license) ----------
const FOOTAGE = {
  'switchgear.mp4': 'https://assets.mixkit.co/videos/23377/23377-720.mp4',
  'substation.mp4': 'https://assets.mixkit.co/videos/23107/23107-720.mp4',
  'plant_aerial.mp4': 'https://assets.mixkit.co/videos/14631/14631-720.mp4',
  'smokestack.mp4': 'https://assets.mixkit.co/videos/14051/14051-720.mp4',
  'pumpjack.mp4': 'https://assets.mixkit.co/videos/48884/48884-360.mp4', // OGI channel source
  'perimeter.mp4': 'https://assets.mixkit.co/videos/36318/36318-720.mp4', // night container yard — perimeter cam
  'tanknight.mp4': 'https://assets.mixkit.co/videos/4360/4360-720.mp4', // petrochemical plant at night
  // ---- Campus East security patrol footage ----
  'campus_quad.mp4': 'https://assets.mixkit.co/videos/4560/4560-720.mp4', // students w/ backpacks crossing the quad
  'campus_gate.mp4': 'https://assets.mixkit.co/videos/4503/4503-720.mp4', // students exiting a teaching building
  'campus_walk.mp4': 'https://assets.mixkit.co/videos/6252/6252-720.mp4', // main walkway pedestrians
  'theft_cctv.mp4': 'https://assets.mixkit.co/videos/31372/31372-720.mp4', // CCTV: pair stuffing backpacks — bag-event evidence
  'intruder.mp4': 'https://assets.mixkit.co/videos/12830/12830-720.mp4', // intruder looks up at the camera
  'parking_night.mp4': 'https://assets.mixkit.co/videos/40735/40735-720.mp4', // parking structure at night
  'night_walkway.mp4': 'https://assets.mixkit.co/videos/40640/40640-720.mp4', // illuminated walkway at night — perimeter round
  'stadium_field.mp4': 'https://assets.mixkit.co/videos/14190/14190-720.mp4', // low flight over the field — mast cam
}

// ---------- robot URDF twins ----------
// DeepRobotics X30 — official model repo (URDF + STL)
const DR = 'https://cdn.jsdelivr.net/gh/DeepRoboticsLab/deep_robotics_model@main'
const ROBOT_FILES = { 'x30/X30.urdf': `${DR}/X30/urdf/X30.urdf` }
for (const m of ['torso', 'hip', 'thigh', 'shank'])
  ROBOT_FILES[`x30/meshes/${m}.STL`] = `${DR}/X30/urdf/meshes/${m}.STL`

// Boston Dynamics Spot — visual OBJs from RAI Institute's spot_description
// (MIT; the ROS 2 driver's description package). The flattened spot.urdf that
// references them is hand-written in-repo (web/public/assets/robots/spot/).
const SPOT = 'https://cdn.jsdelivr.net/gh/rai-opensource/spot_description@main/spot_description/meshes/base/visual'
for (const m of [
  'body',
  'front_left_hip', 'front_left_upper_leg', 'front_left_lower_leg',
  'front_right_hip', 'front_right_upper_leg', 'front_right_lower_leg',
  'rear_left_hip', 'rear_left_upper_leg', 'rear_left_lower_leg',
  'rear_right_hip', 'rear_right_upper_leg', 'rear_right_lower_leg',
])
  ROBOT_FILES[`spot/meshes/${m}.obj`] = `${SPOT}/${m}.obj`

// ---------- media relay (go2rtc) — RTSP → MSE for live playback ----------
// Single static binary, MIT. Bundled so `pnpm dev` can play rtsp:// cameras
// and robot streams out of the box (scripts/relay.mjs starts it). Optional:
// a failure here never blocks setup — RTSP just stays offline until a relay is
// provided (system go2rtc in prod).
const GO2RTC_VERSION = 'v1.9.14'
async function relayBinary() {
  const isWin = process.platform === 'win32'
  const dest = join(ROOT, 'bin', isWin ? 'go2rtc.exe' : 'go2rtc')
  const release = {
    'darwin-arm64': ['go2rtc_mac_arm64.zip', '919b78adc759d6b3883d1e1b2ac915ac0985bb903ff1897b4d228527bd64690c'],
    'darwin-x64': ['go2rtc_mac_amd64.zip', '9b0b9a27a4dc3a5b8b93376e7e8fc2787c6af624a512842622be84aec0171c7a'],
    'linux-x64': ['go2rtc_linux_amd64', '32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6'],
    'linux-arm64': ['go2rtc_linux_arm64', '359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50'],
    'linux-arm': ['go2rtc_linux_arm', '4d7e1639af5a2722a28e864468fd8099b3c1682565446c798bf9e3b38fde12e4'],
    'win32-x64': ['go2rtc_win64.zip', 'dd4167d75cb04abe618855b7c71f8658bd009f60c1a71835d134d2c11c939907'],
  }[`${process.platform}-${process.arch}`]
  if (!release) {
    console.log(`  ⚠ go2rtc: no prebuilt binary for ${process.platform}-${process.arch} — install it manually for RTSP playback`)
    return
  }
  const [asset, expectedSha256] = release
  const binaryStamp = `${dest}.sha256`
  const archiveAsset = asset.endsWith('.zip')
  const cachedBinaryValid = existsSync(dest) && statSync(dest).size > 1e6 && (
    archiveAsset
      ? existsSync(binaryStamp) && readFileSync(binaryStamp, 'utf8').trim() === sha256File(dest)
      : sha256File(dest) === expectedSha256
  )
  if (cachedBinaryValid) return console.log('  ✓ go2rtc (cached, verified)')
  if (existsSync(dest)) unlinkSync(dest)
  if (existsSync(binaryStamp)) unlinkSync(binaryStamp)

  const url = `https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/${asset}`
  mkdirSync(join(ROOT, 'bin'), { recursive: true })
  try {
    if (archiveAsset) {
      const zip = join(ROOT, 'bin', asset)
      await downloadVerified(url, zip, `go2rtc ${GO2RTC_VERSION}`, expectedSha256)
      // zip holds a single `go2rtc` (or .exe) binary — extract flat into bin/
      execSync(`unzip -o -j "${zip}" -d "${join(ROOT, 'bin')}"`, { stdio: 'ignore' })
      unlinkSync(zip)
      writeFileSync(binaryStamp, `${sha256File(dest)}\n`)
    } else {
      await downloadVerified(url, dest, `go2rtc ${GO2RTC_VERSION}`, expectedSha256)
    }
    if (!existsSync(dest) || statSync(dest).size <= 1e6) throw new Error('downloaded binary is missing or unexpectedly small')
    if (!isWin) execSync(`chmod +x "${dest}"`)
    console.log('  ✓ go2rtc ready')
  } catch (e) {
    console.log(`  ⚠ go2rtc download failed (${e.message}) — RTSP playback stays offline until a relay is provided`)
  }
}

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

console.log('[1/4] camera footage (Mixkit free license + Commons)')
for (const [name, url] of Object.entries(FOOTAGE)) await footage(name, url)
await stagingFeed()
await filteredFeed('thermal.mp4', 'smokestack.mp4', 'format=gray,format=gbrp,pseudocolor=preset=inferno,scale=960:-2')
await filteredFeed('ogi.mp4', 'pumpjack.mp4', 'format=gray,eq=contrast=1.55:brightness=-0.06,unsharp=5:5:0.8,noise=alls=5:allf=t,scale=960:-2')
// the data-saver (.low.mp4) tier is retired — sweep any twins from old checkouts
{
  const { readdirSync } = await import('node:fs')
  for (const name of readdirSync(join(ROOT, 'server', 'media')).filter((f) => f.endsWith('.low.mp4'))) {
    unlinkSync(join(ROOT, 'server', 'media', name))
    console.log(`  ✗ ${name} (data-saver tier removed)`)
  }
}

console.log('[2/4] URDF twins — X30 (DeepRoboticsLab) + Spot (RAI spot_description)')
for (const [rel, url] of Object.entries(ROBOT_FILES)) {
  await download(url, join(ROOT, 'web', 'public', 'assets', 'robots', rel), rel)
}

console.log('[3/4] media relay (go2rtc — RTSP → MSE for live playback)')
await relayBinary()

console.log('[4/4] api reference renderer (redoc)')
// Redoc standalone bundle → web/public/vendor/, referenced by api-docs.html
// (served at <BASE>/api-docs.html; relative paths keep it sub-path-safe).
// redoc@2 is the long-stable major — pinned so the URL shape can't drift.
await download(
  'https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js',
  join(ROOT, 'web', 'public', 'vendor', 'redoc.standalone.js'),
  'redoc.standalone.js',
)

console.log('\nAll assets ready. Run: pnpm dev')
