import { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import URDFLoader, { type URDFRobot } from 'urdf-loader'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

const BODY_MAT = new THREE.MeshStandardMaterial({ color: '#39424d', metalness: 0.55, roughness: 0.38 })
const LIMB_MAT = new THREE.MeshStandardMaterial({ color: '#232a32', metalness: 0.5, roughness: 0.45 })

// the only vendored twin is the DeepRobotics X30 (STL meshes: torso + limbs)
const materialFor = (path: string) => (/torso/i.test(path) ? BODY_MAT : LIMB_MAT)

export function loadUrdf(url: string): Promise<URDFRobot> {
  return new Promise((resolve, reject) => {
    const manager = new THREE.LoadingManager()
    const loader = new URDFLoader(manager)
    loader.loadMeshCb = (path, mgr, done) => {
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

// ---------- DeepRobotics leg scheme (X30) ----------

const SCHEME = {
  legs: ['FL', 'FR', 'HL', 'HR'] as const,
  /** trot: diagonal pairs share phase */
  phase: { FL: 0, HR: 0, FR: Math.PI, HL: Math.PI } as Record<string, number>,
  joint: (l: string, p: 'abd' | 'hip' | 'knee') =>
    p === 'abd' ? `${l}_HipX_joint` : p === 'hip' ? `${l}_HipY_joint` : `${l}_Knee_joint`,
  stand: { hip: -0.9, knee: 1.75 },
}

/** Apply the neutral standing pose. */
export function applyStandPose(robot: URDFRobot) {
  for (const leg of SCHEME.legs) {
    robot.joints[SCHEME.joint(leg, 'abd')]?.setJointValue(0)
    robot.joints[SCHEME.joint(leg, 'hip')]?.setJointValue(SCHEME.stand.hip)
    robot.joints[SCHEME.joint(leg, 'knee')]?.setJointValue(SCHEME.stand.knee)
  }
}

/** procedural walk/trot cycle driven by the telemetry gait + speed */
export function useLocomotion(
  robotRef: React.RefObject<URDFRobot | null>,
  opts: { gait?: string; speed?: number } = {},
) {
  const t = useRef(0)
  useFrame((_, dt) => {
    const robot = robotRef.current
    if (!robot) return
    const speed = opts.speed ?? 0.8
    const gait = opts.gait ?? 'walk'
    const moving = gait !== 'stand' && gait !== 'brake' && speed > 0.05
    const freq = gait === 'trot' ? 3.2 : 2.1
    if (moving) t.current += dt * freq * Math.PI * 2

    const swingA = moving ? 0.28 * Math.min(1, speed / 1.2) : 0
    const kneeA = moving ? 0.34 * Math.min(1, speed / 1.2) : 0
    const kneeDir = Math.sign(SCHEME.stand.knee) || 1
    const breathe = Math.sin(performance.now() / 900) * 0.012

    for (const leg of SCHEME.legs) {
      const hip = robot.joints[SCHEME.joint(leg, 'hip')]
      const knee = robot.joints[SCHEME.joint(leg, 'knee')]
      const abd = robot.joints[SCHEME.joint(leg, 'abd')]
      const ph = SCHEME.phase[leg] ?? 0
      if (hip) hip.setJointValue(SCHEME.stand.hip + breathe + swingA * Math.sin(t.current + ph))
      if (knee)
        knee.setJointValue(
          SCHEME.stand.knee -
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
        applyStandPose(r)
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
