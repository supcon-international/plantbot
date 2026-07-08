import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useUrdfRobot } from './UrdfRobot'
import { RafResizeObserver } from './rafResizeObserver'

const URDF_FILE: Record<string, string> = {
  lite3: 'Lite3.urdf',
  x30: 'X30.urdf',
  husky: 'husky.urdf',
}

const LIFT: Record<string, number> = { lite3: 0.3, x30: 0.47, husky: 0.132 }
const CAM_DIST: Record<string, number> = { lite3: 1.25, x30: 1.8, husky: 1.4 }

function Turntable({ urdf, onReady }: { urdf: string; onReady?: () => void }) {
  const url = `/assets/robots/${urdf}/${URDF_FILE[urdf] ?? `${urdf}.urdf`}`
  const { robot } = useUrdfRobot(url)
  const group = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    if (group.current) group.current.rotation.y += dt * 0.35
  })
  useEffect(() => {
    if (robot) onReady?.()
  }, [robot, onReady])
  if (!robot) return null
  return (
    <group ref={group}>
      <group position={[0, LIFT[urdf] ?? 0.3, 0]}>
        <primitive object={robot} />
      </group>
      {/* ground disc hint */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
        <ringGeometry args={[0.52, 0.535, 48]} />
        <meshBasicMaterial color="#2f353c" transparent opacity={0.9} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

/** Lightweight turntable render of a robot — the visual anchor of fleet cards. */
export function RobotThumb({ urdf, className = '' }: { urdf: string; className?: string }) {
  const [ready, setReady] = useState(false)
  const d = CAM_DIST[urdf] ?? 1.35
  return (
    <div className={className} style={{ touchAction: 'pan-y' }}>
      {!ready && <div className="skeleton absolute inset-x-6 top-1/2 h-16 -translate-y-1/2 opacity-30" />}
      <Canvas
        dpr={1.5}
        camera={{ position: [d, d * 0.58, d], fov: 34, near: 0.05, far: 30 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent', pointerEvents: 'none', opacity: ready ? 1 : 0, transition: 'opacity 400ms ease' }}
        resize={{ polyfill: RafResizeObserver as any, scroll: false, debounce: 0 }}
      >
        <hemisphereLight intensity={0.65} groundColor="#0c0d0f" color="#c3ccd6" />
        <directionalLight position={[3, 4, 2]} intensity={1.8} color="#e6ebf1" />
        <directionalLight position={[-4, 2, -3]} intensity={0.55} color="#94a1ae" />
        <Suspense fallback={null}>
          <Turntable urdf={urdf} onReady={() => setReady(true)} />
        </Suspense>
      </Canvas>
    </div>
  )
}
