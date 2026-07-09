import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Grid, ContactShadows, Html } from '@react-three/drei'
import * as THREE from 'three'
import { RafResizeObserver } from './rafResizeObserver'
import { useUrdfRobot, useLocomotion } from './UrdfRobot'
import type { PayloadSpec } from '../lib/types'

/** payload annotation anchors relative to root (post Z-up→Y-up rotation) */
const ANCHORS: Record<string, Record<string, [number, number, number]>> = {
  lite3: {
    ptz: [0.29, 0.02, 0],
    thermal: [0.16, 0.11, 0.11],
    lidar: [-0.02, 0.15, 0],
    imu: [-0.22, 0.05, -0.09],
  },
  x30: {
    optical: [0.46, 0.08, 0],
    gas: [-0.02, 0.3, 0.13],
    acoustic: [0.18, 0.32, -0.13],
    lidar: [-0.38, 0.26, 0],
  },
  husky: {
    ogi: [0.32, 0.33, 0],
    gas: [-0.14, 0.3, 0.15],
    acoustic: [0.04, 0.3, -0.17],
    lidar: [-0.3, 0.38, 0],
  },
}

const URDF_FILE: Record<string, string> = {
  lite3: 'Lite3.urdf',
  x30: 'X30.urdf',
  husky: 'husky.urdf',
  go2: 'Go2.urdf',
  anymal: 'Anymal.urdf',
}

const VIEW_LIFT: Record<string, number> = { lite3: 0.3, x30: 0.47, husky: 0.132, go2: 0.34, anymal: 0.5 }

function RobotScene({
  urdf,
  family,
  gait,
  speed,
  payloads,
  highlight,
  onPick,
}: {
  urdf: string
  family: 'quadruped' | 'ugv'
  gait?: string
  speed?: number
  payloads: PayloadSpec[]
  highlight?: string | null
  onPick?: (id: string | null) => void
}) {
  const url = `/assets/robots/${urdf}/${URDF_FILE[urdf] ?? `${urdf}.urdf`}`
  const { robot, robotRef } = useUrdfRobot(url)
  useLocomotion(robotRef, { family, gait, speed, urdf })
  const anchors = ANCHORS[urdf] ?? {}

  const lift = VIEW_LIFT[urdf] ?? 0.3

  return (
    <group>
      {robot && (
        <group position={[0, lift, 0]}>
          <primitive object={robot} />
          {payloads
            .filter((p) => anchors[p.id])
            .map((p) => {
              const [x, y, z] = anchors[p.id]
              const hot = highlight === p.id
              return (
                <group key={p.id} position={[x, y, z]}>
                  <mesh
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      onPick?.(hot ? null : p.id)
                    }}
                  >
                    <sphereGeometry args={[0.014, 12, 12]} />
                    <meshBasicMaterial color={hot ? '#f2f4f6' : '#9aa2ab'} />
                  </mesh>
                  <mesh scale={hot ? 2.6 : 1.9}>
                    <ringGeometry args={[0.011, 0.013, 24]} />
                    <meshBasicMaterial color={hot ? '#f2f4f6' : '#5d646c'} side={THREE.DoubleSide} transparent opacity={0.9} />
                  </mesh>
                  <Html
                    center
                    distanceFactor={1.5}
                    position={[0, hot ? 0.07 : 0.05, 0]}
                    style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        color: hot ? '#f2f4f6' : 'rgba(154,162,171,0.85)',
                        background: 'rgba(12,13,15,0.72)',
                        border: `1px solid ${hot ? 'rgba(242,244,246,0.5)' : 'rgba(47,53,60,0.9)'}`,
                        padding: '2px 6px',
                        backdropFilter: 'blur(2px)',
                      }}
                    >
                      {p.id}
                    </span>
                  </Html>
                </group>
              )
            })}
        </group>
      )}
      <ContactShadows position={[0, 0.001, 0]} opacity={0.55} scale={3.5} blur={2.6} far={1.2} resolution={512} color="#000000" />
      <Grid
        position={[0, 0, 0]}
        args={[14, 14]}
        cellSize={0.25}
        cellThickness={0.4}
        cellColor="#1d2229"
        sectionSize={1}
        sectionThickness={0.8}
        sectionColor="#272d35"
        fadeDistance={7}
        fadeStrength={2.2}
        infiniteGrid
      />
    </group>
  )
}

export function RobotViewer({
  urdf,
  family = 'quadruped',
  gait,
  speed,
  payloads,
  highlight,
  onPick,
  autoRotate = true,
}: {
  urdf: string
  family?: 'quadruped' | 'ugv'
  gait?: string
  speed?: number
  payloads: PayloadSpec[]
  highlight?: string | null
  onPick?: (id: string | null) => void
  autoRotate?: boolean
}) {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [1.35, 0.85, 1.35], fov: 38, near: 0.05, far: 60 }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: 'transparent', touchAction: 'none' }}
      resize={{ polyfill: RafResizeObserver as any, scroll: false, debounce: 0 }}
      onPointerMissed={() => onPick?.(null)}
    >
      {/* all-local lighting — no network-fetched HDR (keeps Suspense clean offline) */}
      <hemisphereLight intensity={0.6} groundColor="#0c0d0f" color="#c3ccd6" />
      <directionalLight position={[3, 4, 2]} intensity={1.9} color="#e6ebf1" castShadow={false} />
      <directionalLight position={[-4, 2, -3]} intensity={0.65} color="#94a1ae" />
      <directionalLight position={[0, -2, 0]} intensity={0.25} color="#6b7683" />
      <Suspense fallback={null}>
        <RobotScene urdf={urdf} family={family} gait={gait} speed={speed} payloads={payloads} highlight={highlight} onPick={onPick} />
      </Suspense>
      <OrbitControls
        makeDefault
        target={[0, 0.32, 0]}
        autoRotate={autoRotate}
        autoRotateSpeed={0.55}
        minDistance={0.7}
        maxDistance={4.5}
        maxPolarAngle={Math.PI * 0.55}
        enablePan={false}
      />
    </Canvas>
  )
}
