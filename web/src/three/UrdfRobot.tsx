import { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import URDFLoader, { type URDFRobot } from 'urdf-loader'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'

const BODY_MAT = new THREE.MeshStandardMaterial({ color: '#39424d', metalness: 0.55, roughness: 0.38 })
const LIMB_MAT = new THREE.MeshStandardMaterial({ color: '#232a32', metalness: 0.5, roughness: 0.45 })
const HUSKY_BODY = new THREE.MeshStandardMaterial({ color: '#2e343b', metalness: 0.45, roughness: 0.5 })
const HUSKY_TOP = new THREE.MeshStandardMaterial({ color: '#454d56', metalness: 0.5, roughness: 0.42 })
const WHEEL_MAT = new THREE.MeshStandardMaterial({ color: '#15181c', metalness: 0.2, roughness: 0.85 })

function materialFor(path: string) {
  if (/wheel/i.test(path)) return WHEEL_MAT
  if (/top_chassis|user_rail|top_plate/i.test(path)) return HUSKY_TOP
  if (/base_link/i.test(path)) return HUSKY_BODY
  if (/torso/i.test(path)) return BODY_MAT
  return LIMB_MAT
}

export function loadUrdf(url: string): Promise<URDFRobot> {
  return new Promise((resolve, reject) => {
    const manager = new THREE.LoadingManager()
    const loader = new URDFLoader(manager)
    loader.loadMeshCb = (path, mgr, done) => {
      if (/\.dae$/i.test(path)) {
        // vendor collada ships its own materials/textures — keep them
        new ColladaLoader(mgr).load(
          path,
          (dae) => {
            dae.scene.traverse((o) => {
              if (o instanceof THREE.Mesh) o.castShadow = true
            })
            done(dae.scene)
          },
          undefined,
          (err) => done(null as any, err as Error),
        )
        return
      }
      new STLLoader(mgr).load(
        path,
        (geom) => {
          geom.computeVertexNormals()
          const mesh = new THREE.Mesh(geom, materialFor(path))
          mesh.castShadow = true
          done(mesh)
        },
        undefined,
        (err) => done(null as any, err as Error),
      )
    }
    // urdf-loader fires its callback after parsing, before meshes arrive;
    // resolve only once the manager drained so first paint has geometry.
    let robot: URDFRobot | null = null
    manager.onLoad = () => robot && resolve(robot)
    // a missing texture shouldn't kill the whole robot — only geometry is fatal
    manager.onError = (u) => {
      if (/\.(jpe?g|png|webp)(\?|$)/i.test(u)) console.warn('[urdf] texture missing', u)
      else reject(new Error(`mesh failed: ${u}`))
    }
    loader.load(
      url,
      (r) => {
        robot = r
      },
      undefined,
      reject,
    )
  })
}

// ---------- per-vendor leg schemes ----------

interface LegScheme {
  legs: readonly string[]
  /** trot: diagonal pairs share phase */
  phase: Record<string, number>
  joint: (leg: string, part: 'abd' | 'hip' | 'knee') => string
  stand: { hip: number; knee: number }
  /** hind legs of X-configuration robots mirror the sagittal joints */
  sign?: (leg: string) => 1 | -1
}

const SCHEMES: Record<string, LegScheme> = {
  deep: {
    legs: ['FL', 'FR', 'HL', 'HR'],
    phase: { FL: 0, HR: 0, FR: Math.PI, HL: Math.PI },
    joint: (l, p) => (p === 'abd' ? `${l}_HipX_joint` : p === 'hip' ? `${l}_HipY_joint` : `${l}_Knee_joint`),
    stand: { hip: -0.9, knee: 1.75 },
  },
  unitree: {
    legs: ['FL', 'FR', 'RL', 'RR'],
    phase: { FL: 0, RR: 0, FR: Math.PI, RL: Math.PI },
    joint: (l, p) => (p === 'abd' ? `${l}_hip_joint` : p === 'hip' ? `${l}_thigh_joint` : `${l}_calf_joint`),
    stand: { hip: 0.72, knee: -1.45 },
  },
  anymal: {
    legs: ['LF', 'RF', 'LH', 'RH'],
    phase: { LF: 0, RH: 0, RF: Math.PI, LH: Math.PI },
    joint: (l, p) => (p === 'abd' ? `${l}_HAA` : p === 'hip' ? `${l}_HFE` : `${l}_KFE`),
    stand: { hip: 0.44, knee: -0.82 },
    sign: (l) => (l.endsWith('H') ? -1 : 1),
  },
}

const URDF_SCHEME: Record<string, string> = {
  lite3: 'deep',
  x30: 'deep',
  go2: 'unitree',
  anymal: 'anymal',
}

function schemeFor(urdfOrUrl: string): LegScheme {
  for (const [id, sc] of Object.entries(URDF_SCHEME)) if (urdfOrUrl.includes(id)) return SCHEMES[sc]
  return SCHEMES.deep
}

/** Apply the neutral standing pose for whatever quadruped this is. */
export function applyStandPose(robot: URDFRobot, urdfOrUrl: string) {
  const sc = schemeFor(urdfOrUrl)
  for (const leg of sc.legs) {
    const sgn = sc.sign?.(leg) ?? 1
    robot.joints[sc.joint(leg, 'abd')]?.setJointValue(0)
    robot.joints[sc.joint(leg, 'hip')]?.setJointValue(sc.stand.hip * sgn)
    robot.joints[sc.joint(leg, 'knee')]?.setJointValue(sc.stand.knee * sgn)
  }
}

const WHEELS = ['front_left_wheel', 'front_right_wheel', 'rear_left_wheel', 'rear_right_wheel']
const WHEEL_RADIUS = 0.1651

export function useLocomotion(
  robotRef: React.RefObject<URDFRobot | null>,
  opts: { family?: 'quadruped' | 'ugv'; gait?: string; speed?: number; urdf?: string } = {},
) {
  const t = useRef(0)
  const wheelAngle = useRef(0)
  useFrame((_, dt) => {
    const robot = robotRef.current
    if (!robot) return
    const speed = opts.speed ?? 0.8

    if (opts.family === 'ugv') {
      wheelAngle.current += ((speed > 0.03 ? Math.max(speed, 0.25) : 0) / WHEEL_RADIUS) * dt
      for (const w of WHEELS) robot.joints[w]?.setJointValue(wheelAngle.current)
      return
    }

    const sc = schemeFor(opts.urdf ?? '')
    const gait = opts.gait ?? 'walk'
    const moving = gait !== 'stand' && gait !== 'brake' && speed > 0.05
    const freq = gait === 'trot' ? 3.2 : 2.1
    if (moving) t.current += dt * freq * Math.PI * 2

    const swingA = moving ? 0.28 * Math.min(1, speed / 1.2) : 0
    const kneeA = moving ? 0.34 * Math.min(1, speed / 1.2) : 0
    const kneeDir = Math.sign(sc.stand.knee) || 1
    const breathe = Math.sin(performance.now() / 900) * 0.012

    for (const leg of sc.legs) {
      const sgn = sc.sign?.(leg) ?? 1
      const hip = robot.joints[sc.joint(leg, 'hip')]
      const knee = robot.joints[sc.joint(leg, 'knee')]
      const abd = robot.joints[sc.joint(leg, 'abd')]
      const ph = sc.phase[leg] ?? 0
      if (hip) hip.setJointValue(sc.stand.hip * sgn + breathe * sgn + swingA * Math.sin(t.current + ph))
      if (knee)
        knee.setJointValue(
          sc.stand.knee * sgn -
            breathe * 1.4 * kneeDir +
            kneeA * kneeDir * Math.max(0, Math.sin(t.current + ph + Math.PI * 0.5)),
        )
      if (abd) abd.setJointValue(0)
    }
  })
}

export function useUrdfRobot(url: string) {
  const [robot, setRobot] = useState<URDFRobot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<URDFRobot | null>(null)

  useEffect(() => {
    let alive = true
    setRobot(null)
    loadUrdf(url)
      .then((r) => {
        if (!alive) return
        // URDF is Z-up (ROS); three.js is Y-up
        r.rotation.x = -Math.PI / 2
        r.traverse((o) => {
          if (o instanceof THREE.Mesh) o.frustumCulled = false
        })
        applyStandPose(r, url)
        ref.current = r
        setRobot(r)
      })
      .catch((e) => {
        console.error('[urdf] failed', url, e)
        if (alive) setError(String(e))
      })
    return () => {
      alive = false
      ref.current = null
    }
  }, [url])

  return { robot, robotRef: ref, error }
}
