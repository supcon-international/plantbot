#!/usr/bin/env node
/**
 * One-shot asset bootstrap. Downloads every external resource the app needs:
 *  - Mixkit stock footage (free license, loops)        → server/media/
 *  - DeepRobotics Lite3/X30 URDF + STL meshes          → web/public/assets/robots/
 *  - tandt "truck" 3DGS splat (via huggingface),
 *    cropped to an open yard footprint                 → web/public/assets/scenes/
 * Everything is skipped if already present. No dependencies.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs'
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

// ---------- footage (Mixkit free license) ----------
const FOOTAGE = {
  'switchgear.mp4': 'https://assets.mixkit.co/videos/23377/23377-720.mp4',
  'substation.mp4': 'https://assets.mixkit.co/videos/23107/23107-720.mp4',
  'plant_aerial.mp4': 'https://assets.mixkit.co/videos/14631/14631-720.mp4',
  'smokestack.mp4': 'https://assets.mixkit.co/videos/14051/14051-720.mp4',
  'pumpjack.mp4': 'https://assets.mixkit.co/videos/48884/48884-360.mp4', // OGI channel source
  'perimeter.mp4': 'https://assets.mixkit.co/videos/36318/36318-720.mp4', // night container yard — perimeter cam
  'corridor.mp4': 'https://assets.mixkit.co/videos/23378/23378-720.mp4', // machine corridor walk-through
  'tanknight.mp4': 'https://assets.mixkit.co/videos/4360/4360-720.mp4', // petrochemical plant at night
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

// Unitree Go2 (collada, self-contained materials)
const GO2 = 'https://cdn.jsdelivr.net/gh/unitreerobotics/unitree_ros@master/robots/go2_description'
ROBOT_FILES['go2/Go2.urdf'] = { url: `${GO2}/urdf/go2_description.urdf`, relativize: 'go2_description' }
for (const m of ['base', 'calf', 'calf_mirror', 'foot', 'hip', 'thigh', 'thigh_mirror'])
  ROBOT_FILES[`go2/dae/${m}.dae`] = `${GO2}/dae/${m}.dae`

// ANYbotics ANYmal C (collada + jpg textures)
const ANY = 'https://cdn.jsdelivr.net/gh/ANYbotics/anymal_c_simple_description@master'
ROBOT_FILES['anymal/Anymal.urdf'] = { url: `${ANY}/urdf/anymal.urdf`, relativize: 'anymal_c_simple_description' }
for (const m of ['base', 'battery', 'bottom_shell', 'depth_camera', 'drive', 'face', 'foot', 'handle', 'hatch', 'hip_l', 'hip_r', 'lidar', 'lidar_cage', 'remote', 'shank_l', 'shank_r', 'thigh', 'top_shell', 'wide_angle_camera'])
  ROBOT_FILES[`anymal/meshes/${m}.dae`] = `${ANY}/meshes/${m}.dae`
for (const j of ['base', 'battery', 'bottom_shell', 'depth_camera', 'drive', 'face', 'foot', 'handle', 'hatch', 'hip', 'lidar', 'lidar_cage', 'remote', 'shank', 'thigh', 'top_shell', 'wide_angle_camera'])
  ROBOT_FILES[`anymal/meshes/${j}.jpg`] = `${ANY}/meshes/${j}.jpg`

// ---------- gaussian splat scene ----------
async function splatScene() {
  const dest = join(ROOT, 'web', 'public', 'assets', 'scenes', 'building_yard.splat')
  if (existsSync(dest) && statSync(dest).size > 1e6) return console.log('  ✓ building_yard.splat (cached)')
  mkdirSync(dirname(dest), { recursive: true })
  const raw = join(ROOT, 'server', 'media', 'building_raw.ply')
  if (!existsSync(raw) || statSync(raw).size < 3e8) {
    process.stdout.write('  ↓ 3DGS "building" scene (326 MB) … ')
    await download('https://huggingface.co/kishimisu/3d-gaussian-splatting-webgl/resolve/main/building.ply', raw, 'building.ply')
    console.log('done')
  }
  // level + center + scale + crop, baked into the splat (needs python3 + numpy)
  console.log('  ⟲ leveling & baking (scripts/level_splat.py) …')
  execSync(`python3 "${join(ROOT, 'scripts', 'level_splat.py')}" "${raw}" "${dest}" --span 46`, { stdio: 'inherit' })
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

console.log('[2/3] DeepRobotics URDF models (DeepRoboticsLab/deep_robotics_model)')
for (const [rel, spec] of Object.entries(ROBOT_FILES)) {
  const dest = join(ROOT, 'web', 'public', 'assets', 'robots', rel)
  const url = typeof spec === 'string' ? spec : spec.url
  await download(url, dest, rel)
  // vendor URDFs reference package:// — rewrite to relative so the web loader resolves
  if (typeof spec === 'object' && spec.relativize && existsSync(dest)) {
    writeFileSync(dest, readFileSync(dest, 'utf8').replaceAll(`package://${spec.relativize}/`, './'))
  }
}

console.log('[3/3] gaussian splat scene (huggingface cakewalk/splat-data)')
await splatScene()

console.log('\nAll assets ready. Run: pnpm dev')
