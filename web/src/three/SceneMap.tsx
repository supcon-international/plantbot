import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Line, Grid, Html } from '@react-three/drei'
// @ts-expect-error no bundled types
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d'
import * as THREE from 'three'
import { RafResizeObserver } from './rafResizeObserver'
import { useApp } from '../lib/store'
import type { DetectionEvent, RobotSpec } from '../lib/types'
import { SEVERITY_COLOR } from '../lib/types'
import type { MapSel } from '../components/OpsMap'

// Calibration of the public "train" 3DGS capture into our site frame.
// COLMAP y-down → y-up; 0.562 rad yaw from PCA of the hull point cloud.
// tandt "truck" capture: COLMAP y-down, yaw 0.705 rad from hull PCA,
// ground plane at y≈0.5 — open-yard footprint fills the site frame.
export const SPLAT_CALIB = {
  position: [2.5, 0.6, 1.5] as [number, number, number],
  rotation: [Math.PI, 0.705, 0] as [number, number, number],
  scale: 1.2,
}

function SplatStage() {
  const [calib, setCalib] = useState(SPLAT_CALIB)
  const [viewer] = useState(() => {
    const v = new GaussianSplats3D.DropInViewer({
      gpuAcceleratedSort: false,
      sharedMemoryForWorkers: false, // no COOP/COEP needed
      freeIntermediateSplatData: true,
    })
    v.addSplatScene('/assets/scenes/truck_yard.splat', {
      splatAlphaRemovalThreshold: 5,
      showLoadingUI: false,
      progressiveLoad: true,
    })
      .then(() => window.dispatchEvent(new CustomEvent('aegis:splat-ready')))
      .catch(() => window.dispatchEvent(new CustomEvent('aegis:splat-ready')))
    return v
  })
  useEffect(() => {
    ;(window as any).__splat = (position: number[], rotation: number[], scale: number) =>
      setCalib({ position, rotation, scale } as typeof SPLAT_CALIB)
    return () => {
      viewer.dispose?.()
    }
  }, [viewer])
  return (
    <group position={calib.position as any} rotation={calib.rotation as any} scale={calib.scale}>
      <primitive object={viewer} />
    </group>
  )
}

function RobotMarker({ r, selected, onSelect }: { r: RobotSpec; selected: boolean; onSelect: () => void }) {
  const group = useRef<THREE.Group>(null)
  const pulse = useRef<THREE.Mesh>(null)
  const pathRef = useRef<any>(null)

  useFrame(({ clock }) => {
    const tel = useApp.getState().telemetry[r.id]
    if (!tel || !group.current) return
    group.current.position.lerp(new THREE.Vector3(tel.x, 0, tel.z), 0.12)
    group.current.rotation.y = THREE.MathUtils.lerp(group.current.rotation.y, tel.heading, 0.15)
    const t = clock.elapsedTime
    if (pulse.current) {
      const k = (t % 1.8) / 1.8
      pulse.current.scale.setScalar(1 + k * 1.7)
      ;(pulse.current.material as THREE.MeshBasicMaterial).opacity = 0.3 * (1 - k)
    }
  })

  const color = selected ? '#f2f4f6' : r.color

  return (
    <group ref={group} onClick={(e) => (e.stopPropagation(), onSelect())}>
      {r.family === 'ugv' ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.4, 0.48, 4]} />
          <meshBasicMaterial color={color} transparent opacity={0.95} side={THREE.DoubleSide} />
        </mesh>
      ) : (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.42, 0.5, 40]} />
          <meshBasicMaterial color={color} transparent opacity={0.95} side={THREE.DoubleSide} />
        </mesh>
      )}
      <mesh ref={pulse} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
        <ringGeometry args={[0.42, 0.46, 40]} />
        <meshBasicMaterial color={r.color} transparent opacity={0.25} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, -Math.PI / 2]} position={[0.62, 0.03, 0]}>
        <circleGeometry args={[0.17, 3]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <sphereGeometry args={[0.09, 12, 12]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {selected && (
        <mesh position={[0, 0.9, 0]}>
          <cylinderGeometry args={[0.012, 0.012, 1.8, 6]} />
          <meshBasicMaterial color="#f2f4f6" transparent opacity={0.3} />
        </mesh>
      )}
      <Html center position={[0, 1.15, 0]} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }} zIndexRange={[10, 0]}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.1em',
            color: selected ? '#f2f4f6' : 'rgba(230,232,234,0.85)',
            background: 'rgba(12,13,15,0.78)',
            border: `1px solid ${selected ? 'rgba(242,244,246,0.5)' : 'rgba(47,53,60,0.9)'}`,
            padding: '2px 6px',
          }}
        >
          {r.callsign}
        </span>
      </Html>
    </group>
  )
}

function LivePath({ robotId, color }: { robotId: string; color: string }) {
  // subscribe at 4 Hz via the store; never setState inside useFrame
  const tel = useApp((s) => s.telemetry[robotId])
  const pts = useMemo(() => {
    if (!tel || tel.path.length === 0) return null
    return [
      [tel.x, 0.04, tel.z] as [number, number, number],
      ...tel.path.map((p) => [p.x, 0.04, p.z] as [number, number, number]),
    ]
  }, [tel])
  if (!pts || pts.length < 2) return null
  return <Line points={pts} color={color} lineWidth={1.2} dashed dashSize={0.4} gapSize={0.26} transparent opacity={0.75} />
}

function EventPin({ ev, onSelect, selected }: { ev: DetectionEvent; onSelect: () => void; selected: boolean }) {
  const color = SEVERITY_COLOR[ev.severity]
  const head = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (head.current && ev.severity === 'critical') {
      const s = 1 + 0.25 * Math.sin(clock.elapsedTime * 5)
      head.current.scale.setScalar(s)
    }
  })
  return (
    <group position={[ev.x, 0, ev.z]} onClick={(e) => (e.stopPropagation(), onSelect())}>
      <mesh position={[0, 0.45, 0]}>
        <cylinderGeometry args={[0.014, 0.014, 0.9, 6]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 0.9 : 0.45} />
      </mesh>
      <mesh ref={head} position={[0, 0.95, 0]}>
        <octahedronGeometry args={[0.12]} />
        <meshBasicMaterial color={color} wireframe={!selected} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.14, 0.18, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

function CameraRig({ selection, follow }: { selection: MapSel; follow: boolean }) {
  const controls = useRef<any>(null)
  useFrame(() => {
    if (!controls.current) return
    if (follow && selection?.kind === 'robot') {
      const tel = useApp.getState().telemetry[selection.id]
      if (tel) {
        controls.current.target.lerp(new THREE.Vector3(tel.x, 0.3, tel.z), 0.06)
        controls.current.update()
      }
    }
  })
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={[0, 0.4, 0]}
      minDistance={3}
      maxDistance={38}
      maxPolarAngle={Math.PI * 0.49}
      enableDamping
      dampingFactor={0.08}
    />
  )
}

export function SceneMap({
  selection,
  onSelect,
  follow,
  quality,
}: {
  selection: MapSel
  onSelect: (s: MapSel) => void
  follow: boolean
  quality: 'high' | 'lite'
}) {
  const robots = useApp((s) => s.robots)
  const events = useApp((s) => s.events)
  const pins = useMemo(
    () => events.filter((e) => !e.acked && Date.now() - e.ts < 45 * 60_000).slice(0, 12),
    [events],
  )
  return (
    <Canvas
      dpr={quality === 'high' ? [1, 1.75] : 1}
      camera={{ position: [13, 10.5, 16.5], fov: 42, near: 0.1, far: 300 }}
      gl={{ antialias: false, alpha: true, powerPreference: 'high-performance' }}
      style={{ touchAction: 'none' }}
      resize={{ polyfill: RafResizeObserver as any, scroll: false, debounce: 0 }}
      onPointerMissed={() => onSelect(null)}
    >
      <hemisphereLight intensity={0.35} color="#c3ccd6" groundColor="#0c0d0f" />
      <Suspense fallback={null}>
        <SplatStage />
      </Suspense>

      <Grid
        position={[0, 0.005, 0]}
        args={[32, 18]}
        cellSize={1}
        cellThickness={0.35}
        cellColor="#1b2026"
        sectionSize={4}
        sectionThickness={0.7}
        sectionColor="#262d35"
        fadeDistance={46}
        fadeStrength={1.6}
      />
      <Line
        points={[
          [-16, 0.02, -9],
          [16, 0.02, -9],
          [16, 0.02, 9],
          [-16, 0.02, 9],
          [-16, 0.02, -9],
        ]}
        color="#2f353c"
        lineWidth={1}
      />

      {robots.map((r) => (
        <group key={r.id}>
          <LivePath robotId={r.id} color={selection?.kind === 'robot' && selection.id === r.id ? '#f2f4f6' : r.color} />
          <RobotMarker
            r={r}
            selected={selection?.kind === 'robot' && selection.id === r.id}
            onSelect={() => onSelect({ kind: 'robot', id: r.id })}
          />
        </group>
      ))}

      {pins.map((ev) => (
        <EventPin
          key={ev.id}
          ev={ev}
          selected={selection?.kind === 'event' && selection.id === ev.id}
          onSelect={() => onSelect({ kind: 'event', id: ev.id })}
        />
      ))}

      <CameraRig selection={selection} follow={follow} />
    </Canvas>
  )
}
