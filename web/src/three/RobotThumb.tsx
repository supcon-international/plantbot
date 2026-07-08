import { Suspense, useRef } from 'react'
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

function Turntable({ urdf }: { urdf: string }) {
  const url = `/assets/robots/${urdf}/${URDF_FILE[urdf] ?? `${urdf}.urdf`}`
  const { robot } = useUrdfRobot(url)
  const group = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    if (group.current) group.current.rotation.y += dt * 0.35
  })
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
  return (
    <div className={className} style={{ touchAction: 'pan-y' }}>
      <Canvas
        dpr={1.5}
        camera={{ position: [1.25, 0.72, 1.25], fov: 34, near: 0.05, far: 30 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent', pointerEvents: 'none' }}
        resize={{ polyfill: RafResizeObserver as any, scroll: false, debounce: 0 }}
      >
        <hemisphereLight intensity={0.65} groundColor="#0c0d0f" color="#c3ccd6" />
        <directionalLight position={[3, 4, 2]} intensity={1.8} color="#e6ebf1" />
        <directionalLight position={[-4, 2, -3]} intensity={0.55} color="#94a1ae" />
        <Suspense fallback={null}>
          <Turntable urdf={urdf} />
        </Suspense>
      </Canvas>
    </div>
  )
}
