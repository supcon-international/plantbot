#!/usr/bin/env node
/**
 * One-shot asset bootstrap. Downloads every external resource the app needs:
 *  - Mixkit stock footage (free license) + Wikimedia Spot clip → server/media/
 *  - URDF twins: DeepRobotics X30 (official model repo) and Boston Dynamics
 *    Spot (RAI Institute spot_description visual meshes, MIT; the flattened
 *    spot.urdf lives in-repo) — GS F2 renders as a silhouette
 *                                                      → web/public/assets/robots/
 *  - SKANOSFERA warehouse 3DGS scan (superspl.at), merged from SOG
 *    chunks and leveled by scripts/level_splat.py      → web/public/assets/scenes/
 * Everything is skipped if already present.
 * Host requirements: node ≥ 20, ffmpeg on PATH, python3 with numpy.
 */
import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

// ---------- host prerequisites ----------
function preflight() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' })
  } catch {
    console.error('✗ ffmpeg not found on PATH — install it (macOS: brew install ffmpeg) and rerun.')
    process.exit(1)
  }
  try {
    execSync('python3 -c "import numpy"', { stdio: 'ignore' })
  } catch {
    console.error('✗ python3 with numpy is required for the splat pipeline — `pip3 install numpy` and rerun.')
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

// ---------- gaussian splat scene ----------
async function splatScene() {
  const dest = join(ROOT, 'web', 'public', 'assets', 'scenes', 'plant_yard.splat')
  if (existsSync(dest) && statSync(dest).size > 1e6) return console.log('  ✓ plant_yard.splat (cached)')
  mkdirSync(dirname(dest), { recursive: true })
  // SKANOSFERA "Hala Magazynowa" warehouse scan, published on superspl.at
  // (scene 3eedaa2b). We pull the LOD-2 SOG chunks, merge them to a 3DGS ply
  // with @playcanvas/splat-transform, then level/center/scale via level_splat.
  const work = join(ROOT, 'server', 'media', 'hala')
  const base = 'https://d28zzqy0iyovbz.cloudfront.net/3eedaa2b/v1'
  const chunks = ['2_0', '2_1', '2_2', '2_3', '2_4']
  const files = ['meta.json', 'means_l.webp', 'means_u.webp', 'scales.webp', 'quats.webp', 'sh0.webp']
  for (const c of chunks) {
    mkdirSync(join(work, c), { recursive: true })
    for (const f of files) {
      const p = join(work, c, f)
      if (!existsSync(p) || statSync(p).size < 200) await download(`${base}/${c}/${f}`, p, `${c}/${f}`)
    }
  }
  const ply = join(work, 'hala.ply')
  if (!existsSync(ply) || statSync(ply).size < 1e8) {
    console.log('  ⇄ merging SOG chunks (splat-transform) …')
    execSync(`npx --yes @playcanvas/splat-transform ${chunks.map((c) => join(work, c, 'meta.json')).join(' ')} "${ply}"`, {
      stdio: 'inherit',
    })
  }
  console.log('  ⟲ leveling & baking (scripts/level_splat.py) …')
  execSync(`python3 "${join(ROOT, 'scripts', 'level_splat.py')}" "${ply}" "${dest}" --span 38 --ymax 6.5`, { stdio: 'inherit' })
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

console.log('[1/3] camera footage (Mixkit free license + Commons)')
for (const [name, url] of Object.entries(FOOTAGE)) await footage(name, url)
await stagingFeed()
await filteredFeed('thermal.mp4', 'smokestack.mp4', 'format=gray,format=gbrp,pseudocolor=preset=inferno,scale=960:-2')
await filteredFeed('ogi.mp4', 'pumpjack.mp4', 'format=gray,eq=contrast=1.55:brightness=-0.06,unsharp=5:5:0.8,noise=alls=5:allf=t,scale=960:-2')
// the data-saver (.low.mp4) tier is retired — sweep any twins from old checkouts
{
  const { readdirSync, unlinkSync } = await import('node:fs')
  for (const name of readdirSync(join(ROOT, 'server', 'media')).filter((f) => f.endsWith('.low.mp4'))) {
    unlinkSync(join(ROOT, 'server', 'media', name))
    console.log(`  ✗ ${name} (data-saver tier removed)`)
  }
}

console.log('[2/3] URDF twins — X30 (DeepRoboticsLab) + Spot (RAI spot_description)')
for (const [rel, url] of Object.entries(ROBOT_FILES)) {
  await download(url, join(ROOT, 'web', 'public', 'assets', 'robots', rel), rel)
}

console.log('[3/3] gaussian splat scene (huggingface cakewalk/splat-data)')
await splatScene()

console.log('\nAll assets ready. Run: pnpm dev')
