import { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import URDFLoader, { type URDFRobot } from 'urdf-loader'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'

const BODY_MAT = new THREE.MeshStandardMaterial({ color: '#39424d', metalness: 0.55, roughness: 0.38 })
const LIMB_MAT = new THREE.MeshStandardMaterial({ color: '#232a32', metalness: 0.5, roughness: 0.45 })
// Spot wears a bright arctic-white shell — the dark steel palette made it
// unreadable against the console's black stage
const SPOT_BODY_MAT = new THREE.MeshStandardMaterial({ color: '#e9eaec', metalness: 0.2, roughness: 0.5 })
const SPOT_LIMB_MAT = new THREE.MeshStandardMaterial({ color: '#c6cad0', metalness: 0.25, roughness: 0.55 })

// two vendored twins: X30 (STL: torso + limbs, steel) and Spot (OBJ: body +
// legs, white). Vendor materials are ignored — we skin every mesh ourselves.
const materialFor = (path: string) => {
  const body = /torso|body/i.test(path)
  if (/\/spot\//i.test(path)) return body ? SPOT_BODY_MAT : SPOT_LIMB_MAT
  return body ? BODY_MAT : LIMB_MAT
}

export function loadUrdf(url: string): Promise<URDFRobot> {
  return new Promise((resolve, reject) => {
    const manager = new THREE.LoadingManager()
    const loader = new URDFLoader(manager)
    // urdf-loader ≥0.13 passes the parsed vendor material as the 3rd arg; we
    // skin every mesh ourselves (materialFor), so it's ignored — done is 4th.
    loader.loadMeshCb = (path, mgr, _material, done) => {
      if (/\.obj$/i.test(path)) {
        // Spot visual meshes — plain geometry, mtllib ignored (we skin them)
        new OBJLoader(mgr).load(
          path,
          (group) => {
            group.traverse((o) => {
              if (o instanceof THREE.Mesh) {
                o.material = materialFor(path)
                o.castShadow = true
              }
            })
            done(group)
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
}

const SCHEMES: Record<string, LegScheme> = {
  // DeepRobotics X30 — knee extends positive
  x30: {
    legs: ['FL', 'FR', 'HL', 'HR'],
    phase: { FL: 0, HR: 0, FR: Math.PI, HL: Math.PI },
    joint: (l, p) => (p === 'abd' ? `${l}_HipX_joint` : p === 'hip' ? `${l}_HipY_joint` : `${l}_Knee_joint`),
    stand: { hip: -0.9, knee: 1.75 },
  },
  // Boston Dynamics Spot (RAI spot_description) — knee range is negative
  spot: {
    legs: ['front_left', 'front_right', 'rear_left', 'rear_right'],
    phase: { front_left: 0, rear_right: 0, front_right: Math.PI, rear_left: Math.PI },
    joint: (l, p) => (p === 'abd' ? `${l}_hip_x` : p === 'hip' ? `${l}_hip_y` : `${l}_knee`),
    stand: { hip: 0.72, knee: -1.45 },
  },
}

const schemeFor = (urdfOrUrl: string): LegScheme => (urdfOrUrl.includes('spot') ? SCHEMES.spot : SCHEMES.x30)

/** Apply the neutral standing pose. */
export function applyStandPose(robot: URDFRobot, urdfOrUrl: string) {
  const sc = schemeFor(urdfOrUrl)
  for (const leg of sc.legs) {
    robot.joints[sc.joint(leg, 'abd')]?.setJointValue(0)
    robot.joints[sc.joint(leg, 'hip')]?.setJointValue(sc.stand.hip)
    robot.joints[sc.joint(leg, 'knee')]?.setJointValue(sc.stand.knee)
  }
}

/** procedural walk/trot cycle driven by the telemetry gait + speed */
export function useLocomotion(
  robotRef: React.RefObject<URDFRobot | null>,
  opts: { gait?: string; speed?: number; urdf?: string } = {},
) {
  const t = useRef(0)
  useFrame((_, dt) => {
    const robot = robotRef.current
    if (!robot) return
    const sc = schemeFor(opts.urdf ?? '')
    const speed = opts.speed ?? 0.8
    const gait = opts.gait ?? 'walk'
    const moving = gait !== 'stand' && gait !== 'brake' && speed > 0.05
    const freq = gait === 'trot' ? 3.2 : 2.1
    if (moving) t.current += dt * freq * Math.PI * 2

    const swingA = moving ? 0.28 * Math.min(1, speed / 1.2) : 0
    const kneeA = moving ? 0.34 * Math.min(1, speed / 1.2) : 0
    const kneeDir = Math.sign(sc.stand.knee) || 1
    const breathe = Math.sin(performance.now() / 900) * 0.012

    for (const leg of sc.legs) {
      const hip = robot.joints[sc.joint(leg, 'hip')]
      const knee = robot.joints[sc.joint(leg, 'knee')]
      const abd = robot.joints[sc.joint(leg, 'abd')]
      const ph = sc.phase[leg] ?? 0
      if (hip) hip.setJointValue(sc.stand.hip + breathe + swingA * Math.sin(t.current + ph))
      if (knee)
        knee.setJointValue(
          sc.stand.knee -
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
    let loaded: URDFRobot | null = null
    setRobot(null)
    // <primitive> objects aren't reclaimed by R3F: dispose every geometry on
    // swap/unmount. Materials are module-level singletons — never dispose them.
    const disposeGeom = (r: URDFRobot) =>
      r.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
    loadUrdf(url)
      .then((r) => {
        // load can finish after the effect tore down (url change / unmount) —
        // that robot never mounts, so dispose it here instead of leaking it.
        if (!alive) {
          disposeGeom(r)
          return
        }
        // URDF is Z-up (ROS); three.js is Y-up
        r.rotation.x = -Math.PI / 2
        r.traverse((o) => {
          if (o instanceof THREE.Mesh) o.frustumCulled = false
        })
        applyStandPose(r, url)
        loaded = r
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
      if (loaded) disposeGeom(loaded)
    }
  }, [url])

  return { robot, robotRef: ref, error }
}
