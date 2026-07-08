import { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import URDFLoader, { type URDFRobot } from 'urdf-loader'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

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
    manager.onError = (u) => reject(new Error(`mesh failed: ${u}`))
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

/** Neutral standing pose for DeepRobotics quadrupeds (HipY/Knee convention). */
export const STAND_POSE: Record<string, number> = {
  HipX: 0,
  HipY: -0.9,
  Knee: 1.75,
}

const LEGS = ['FL', 'FR', 'HL', 'HR'] as const
// trot: diagonal pairs in phase
const PHASE: Record<(typeof LEGS)[number], number> = { FL: 0, HR: 0, FR: Math.PI, HL: Math.PI }

const WHEELS = ['front_left_wheel', 'front_right_wheel', 'rear_left_wheel', 'rear_right_wheel']
const WHEEL_RADIUS = 0.1651

export function useLocomotion(
  robotRef: React.RefObject<URDFRobot | null>,
  opts: { family?: 'quadruped' | 'ugv'; gait?: string; speed?: number } = {},
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

    const gait = opts.gait ?? 'walk'
    const moving = gait !== 'stand' && gait !== 'brake' && speed > 0.05
    const freq = gait === 'trot' ? 3.2 : 2.1
    if (moving) t.current += dt * freq * Math.PI * 2

    const swingA = moving ? 0.28 * Math.min(1, speed / 1.2) : 0
    const kneeA = moving ? 0.34 * Math.min(1, speed / 1.2) : 0
    const breathe = Math.sin(performance.now() / 900) * 0.012

    for (const leg of LEGS) {
      const hipY = robot.joints[`${leg}_HipY_joint`]
      const knee = robot.joints[`${leg}_Knee_joint`]
      const hipX = robot.joints[`${leg}_HipX_joint`]
      const ph = PHASE[leg]
      if (hipY) hipY.setJointValue(STAND_POSE.HipY + breathe + swingA * Math.sin(t.current + ph))
      if (knee)
        knee.setJointValue(
          STAND_POSE.Knee - breathe * 1.4 + kneeA * Math.max(0, Math.sin(t.current + ph + Math.PI * 0.5)),
        )
      if (hipX) hipX.setJointValue(0)
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
        for (const [name, j] of Object.entries(r.joints)) {
          const kind = name.match(/Hip[XY]|Knee/)?.[0]
          if (kind && kind in STAND_POSE) j.setJointValue(STAND_POSE[kind])
        }
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
